/**
 * Our own microphone and camera, read back from the SDK rather than assumed.
 *
 * `defaults: { audio: true }` is a request, not a promise: the browser can
 * refuse, iOS can hand over a muted track, a device can vanish. The buttons
 * used to assume success and only flip on click, which is how one side sat
 * "unmuted" while the other saw "muted". Now they follow the SDK, and a
 * microphone that is off without anyone asking gets a banner with the fix.
 *
 * The fix has to be a FRESH CAPTURE. The SDK's disableAudio()/enableAudio()
 * only flip `enabled` on the track it already holds (@cloudflare/realtimekit
 * 2.0.2: muteTrack/unmuteTrack), and a track the platform has muted —
 * `track.muted`, which iOS sets and no page can clear — stays muted through
 * any number of those. setDevice() stops the track and calls getUserMedia
 * again; that is what "Fix microphone" does, and what happens on its own when
 * a mute lasts (see recovery.ts).
 */

import { describe } from './boot'
import { els } from './dom'
import { call } from './state'
import { micMeter } from './meters'
import { renderAudioStatus } from './status'
import { note, sendDiagnostics } from './diagnostics'
import { MUTE_SETTLE_MS } from './recovery'
import type { RtkMeeting } from './sdk'

let watchedTrack: MediaStreamTrack | null = null

/** True when the SDK says audio is on but the track underneath cannot carry it. */
export function selfTrackMuted(): boolean {
  const track = call.meeting?.self.audioTrack
  return Boolean(track && (track.muted || track.readyState === 'ended'))
}

/** Mute/unmute/ended on our own track fire outside the SDK's events; follow them. */
function watchTrack(track: MediaStreamTrack | null): void {
  if (track === watchedTrack) return
  watchedTrack = track
  if (!track) return
  note('track', { id: track.id.slice(0, 8), label: track.label, muted: track.muted })
  for (const event of ['mute', 'unmute', 'ended'] as const) {
    track.addEventListener(event, () => {
      if (call.meeting?.self.audioTrack !== track) return
      note(`track:${event}`, { id: track.id.slice(0, 8) })
      if (event === 'mute') call.recovery.mutedSince ??= Date.now()
      if (event === 'unmute') {
        call.recovery.mutedSince = null
        call.stuckMuted = false
      }
      syncSelfControls()
    })
  }
}

/** Subscribes to the SDK's own-side events. Once, right after init. */
export function wireSelf(): void {
  const meeting = call.meeting
  if (!meeting) return
  meeting.self.on('audioUpdate', () => syncSelfControls())
  meeting.self.on('videoUpdate', () => syncSelfControls())
  meeting.self.on('mediaPermissionError', (...args: unknown[]) => {
    const detail = args[0] as { message?: string; kind?: string } | undefined
    call.lastMediaError = detail?.message ? `${detail.kind ?? 'device'}: ${detail.message}` : 'the browser refused a device'
    note('mediaPermissionError', detail)
    syncSelfControls()
  })
}

/** The mic and camera buttons, the labels, and the "your microphone is off" banner. */
export function syncSelfControls(): void {
  const meeting = call.meeting
  if (!meeting) return
  const audioOn = meeting.self.audioEnabled
  const videoOn = meeting.self.videoEnabled
  els.mic.classList.toggle('off', !audioOn)
  els.mic.setAttribute('aria-pressed', String(!audioOn))
  els.mic.setAttribute('aria-label', audioOn ? 'Mute microphone' : 'Unmute microphone')
  els.micLabel.textContent = audioOn ? 'Mute' : 'Unmute'
  els.cam.classList.toggle('off', !videoOn)
  els.cam.setAttribute('aria-pressed', String(!videoOn))
  els.cam.setAttribute('aria-label', videoOn ? 'Turn camera off' : 'Turn camera on')
  watchTrack(meeting.self.audioTrack ?? null)

  // Off without you asking for it: say so on YOUR screen. The other side only
  // ever sees "mic off", which sends them looking in the wrong place. Two
  // cases: the SDK never got a microphone, or it has one that the platform
  // muted underneath it — iOS does that to the earlier capture when anything
  // captures again, and reports it as track.muted, not as "disabled".
  const trackMuted = audioOn && selfTrackMuted()
  if (!trackMuted) call.stuckMuted = false
  const unexpected = !call.finishing && ((!audioOn && !call.selfMuted) || trackMuted)
  els.micOff.classList.toggle('hidden', !unexpected)
  if (unexpected) {
    els.micOffText.textContent = trackMuted
      ? call.stuckMuted
        ? 'Your phone keeps muting the microphone. Bring this app to the front, end any other call that is using the microphone, then try again — or reload the page.'
        : 'Your phone muted the microphone — the other side cannot hear you.'
      : call.lastMediaError
        ? `Your microphone is off (${call.lastMediaError}).`
        : 'Your microphone is off — the other side cannot hear you.'
    els.micOffFix.textContent = trackMuted ? (call.stuckMuted ? 'Try again' : 'Fix microphone') : 'Turn it on'
  }
  renderAudioStatus()
}

/**
 * Releases the microphone and captures it again. The newest capture is the
 * one a phone keeps live, so this is the fix for a track the platform muted.
 * Runs on its own when a mute lasts (reconcile.ts, within the limits in
 * recovery.ts); the banner button can retry as often as it likes.
 */
export async function recoverMicrophone(trigger: 'auto' | 'tap'): Promise<void> {
  const meeting = call.meeting
  if (!meeting || call.recovering) return
  call.recovering = true
  els.micOffFix.disabled = true
  const before = meeting.self.audioTrack ?? null
  note('recover:start', { trigger, id: before?.id.slice(0, 8), muted: before?.muted })
  try {
    // Nothing of ours may hold the capture while the new one is requested: on
    // iOS the newest capture is the one that stays live.
    micMeter.detach()
    await reacquire(meeting)
    call.lastMediaError = null
  } catch (error) {
    call.lastMediaError = describe(error)
    note('recover:error', describe(error))
  } finally {
    call.recovering = false
    els.micOffFix.disabled = false
  }
  const after = meeting.self.audioTrack ?? null
  call.recovery.mutedSince = after && (after.muted || after.readyState === 'ended') ? Date.now() : null
  micMeter.attach(meeting.self.audioEnabled ? after : null)
  syncSelfControls()

  // Judged once iOS has had a moment: a fresh track can report muted for a
  // few hundred milliseconds before it starts. One still muted after that is
  // the platform holding the microphone, and the banner says so.
  setTimeout(() => {
    if (meeting.self.audioTrack !== after || call.finishing) return
    const stuck = selfTrackMuted()
    call.stuckMuted = stuck
    note('recover:result', { trigger, id: after?.id.slice(0, 8), newTrack: after !== before, muted: after?.muted, stuck })
    syncSelfControls()
    if (stuck || trigger === 'tap') void sendDiagnostics(stuck ? 'still-muted' : 'recovered')
  }, MUTE_SETTLE_MS)
}

/** A fresh capture through the SDK, so it publishes the new track itself. */
async function reacquire(meeting: RtkMeeting): Promise<void> {
  const current = meeting.self.getCurrentDevices().audio ?? call.microphones[0]
  if (current) {
    await meeting.self.setDevice({ ...current, kind: 'audioinput' })
    return
  }
  // No device information at all (some browsers withhold it): capture one
  // ourselves and hand it over. The SDK treats a handed-over track as custom
  // and will not stop the old one, so that is done here.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const [fresh] = stream.getAudioTracks()
  if (!fresh) throw new Error('no microphone track')
  const old = meeting.self.audioTrack
  await meeting.self.disableAudio()
  old?.stop()
  await meeting.self.enableAudio(fresh)
}

export async function turnMicOn(): Promise<void> {
  const meeting = call.meeting
  if (!meeting) return
  call.selfMuted = false
  els.micOffFix.disabled = true
  try {
    await meeting.self.enableAudio()
    call.lastMediaError = null
  } catch (error) {
    call.lastMediaError = describe(error)
    note('enableAudio:error', describe(error))
  } finally {
    els.micOffFix.disabled = false
  }
  if (meeting.self.audioEnabled && selfTrackMuted()) {
    // On in the SDK's eyes, still muted by the platform: only a fresh capture helps.
    await recoverMicrophone('tap')
    return
  }
  micMeter.attach(meeting.self.audioTrack ?? null)
  syncSelfControls()
}

/** The mute button: a deliberate mute is remembered, so the banner stays quiet. */
export async function toggleMicrophone(): Promise<void> {
  const meeting = call.meeting
  if (!meeting) return
  try {
    if (meeting.self.audioEnabled) {
      call.selfMuted = true
      await meeting.self.disableAudio()
    } else {
      call.selfMuted = false
      await meeting.self.enableAudio()
      call.lastMediaError = null
    }
  } catch (error) {
    call.lastMediaError = describe(error)
  }
  if (meeting.self.audioEnabled && selfTrackMuted()) {
    await recoverMicrophone('tap')
    return
  }
  micMeter.attach(meeting.self.audioEnabled ? (meeting.self.audioTrack ?? null) : null)
  syncSelfControls()
}

export async function toggleCamera(): Promise<void> {
  const meeting = call.meeting
  if (!meeting) return
  try {
    if (meeting.self.videoEnabled) await meeting.self.disableVideo()
    else await meeting.self.enableVideo()
  } catch (error) {
    els.settingsHint.textContent = `Camera: ${describe(error)}`
  }
  syncSelfControls()
}

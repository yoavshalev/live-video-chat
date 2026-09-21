/**
 * Our own microphone and camera, read back from the SDK rather than assumed.
 *
 * `defaults: { audio: true }` is a request, not a promise: the browser can
 * refuse, iOS can hand over a muted track, a device can vanish. The buttons
 * used to assume success and only flip on click, which is how one side sat
 * "unmuted" while the other saw "muted". Now they follow the SDK, and a
 * microphone that is off without anyone asking gets a banner with the fix.
 */

import { describe } from './boot'
import { els } from './dom'
import { call } from './state'
import { micMeter } from './meters'
import { renderAudioStatus } from './status'

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
  for (const event of ['mute', 'unmute', 'ended']) {
    track.addEventListener(event, () => {
      if (call.meeting?.self.audioTrack === track) syncSelfControls()
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
    console.warn('[call] media permission error', detail)
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
  const unexpected = !call.finishing && ((!audioOn && !call.selfMuted) || trackMuted)
  els.micOff.classList.toggle('hidden', !unexpected)
  if (unexpected) {
    els.micOffText.textContent = trackMuted
      ? 'Your phone muted the microphone — the other side cannot hear you.'
      : call.lastMediaError
        ? `Your microphone is off (${call.lastMediaError}).`
        : 'Your microphone is off — the other side cannot hear you.'
    els.micOffFix.textContent = trackMuted ? 'Fix microphone' : 'Turn it on'
  }
  renderAudioStatus()
}

/**
 * Releases and re-acquires the microphone. The newest capture is the one a
 * phone keeps live, so this is the fix for a track the platform muted.
 * Runs automatically once per call (reconcile.ts); the banner button can
 * retry as often as it likes.
 */
export async function recoverMicrophone(): Promise<void> {
  const meeting = call.meeting
  if (!meeting || call.recovering) return
  call.recovering = true
  els.micOffFix.disabled = true
  try {
    await meeting.self.disableAudio()
    await meeting.self.enableAudio()
    call.lastMediaError = null
    console.info('[call] microphone re-acquired', meeting.self.audioTrack?.label)
  } catch (error) {
    call.lastMediaError = describe(error)
    console.warn('[call] microphone recovery failed', error)
  } finally {
    call.recovering = false
    els.micOffFix.disabled = false
  }
  micMeter.attach(meeting.self.audioTrack ?? null)
  syncSelfControls()
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
    console.warn('[call] enableAudio failed', error)
  } finally {
    els.micOffFix.disabled = false
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

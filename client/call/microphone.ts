/**
 * Our own microphone and camera: what the person wants, what the SDK has,
 * and the one routine that closes the gap.
 *
 * Two facts drive everything here. The intent — `call.selfMuted`, set only by
 * the mute button — and the status, read off the SDK's track by capture.ts.
 * When the intent is "on" and the status is anything else, the banner says
 * so on THIS person's screen (the other side only ever sees "mic off", which
 * sends them looking in the wrong place) and ensureMicrophone() is the single
 * path that makes it right: a flag flip for a track the SDK merely disabled, a
 * fresh capture for one the platform muted, ended, or never delivered. It runs
 * on a tap of the banner, on the mute button's unmute, and — where a capture
 * may start on its own — automatically, under the policy in recovery.ts.
 */

import { describe } from './boot'
import { captureMicrophone, microphoneStatus, type MicrophoneStatus } from './capture'
import { note, sendDiagnostics } from './diagnostics'
import { els } from './dom'
import { micMeter } from './meters'
import { systemMuteHint } from './platform'
import { MUTE_SETTLE_MS } from './recovery'
import { call } from './state'
import { renderAudioStatus } from './status'

let watchedTrack: MediaStreamTrack | null = null

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

/** Mute, unmute and ended on our own track fire outside the SDK's events; follow them. */
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

/**
 * Makes the microphone match an intent of "on". The only path that turns a
 * microphone on, so every caller gets the same care: the result is verified,
 * a refusal is explained, and a phone that mutes even a fresh capture is
 * told what to check.
 */
export async function ensureMicrophone(trigger: 'auto' | 'tap'): Promise<void> {
  const meeting = call.meeting
  if (!meeting || call.recovering || call.selfMuted) return
  const status = microphoneStatus(meeting)
  if (status === 'on') return

  call.recovering = true
  setBusy(true)
  const before = meeting.self.audioTrack ?? null
  note('mic:ensure', { trigger, status, id: before?.id.slice(0, 8) })
  try {
    // The meter only reads the track, but it is detached anyway so the capture
    // below sees exactly the state the SDK is in.
    micMeter.detach()
    let result: { ok: true } | { ok: false; reason: string } = { ok: true }
    if (status === 'off') {
      // A live track the SDK merely disabled: its own switch is the right tool.
      await meeting.self.enableAudio()
    }
    if (status !== 'off' || microphoneStatus(meeting) !== 'on') result = await captureMicrophone(meeting)
    call.lastMediaError = result.ok ? null : result.reason
  } catch (error) {
    call.lastMediaError = describe(error)
    note('mic:error', describe(error))
  } finally {
    call.recovering = false
    setBusy(false)
  }

  const after = meeting.self.audioTrack ?? null
  const outcome = microphoneStatus(meeting)
  call.recovery.mutedSince = outcome === 'muted' || outcome === 'ended' ? Date.now() : null
  micMeter.attach(meeting.self.audioEnabled ? after : null)
  syncSelfControls()

  if (outcome !== 'on' && outcome !== 'muted') {
    note('mic:failed', { trigger, outcome, error: call.lastMediaError })
    void sendDiagnostics('capture-failed')
    return
  }
  // A fresh track can report muted for a few hundred milliseconds before it
  // starts. Judged once that has passed: one still muted then is the platform
  // holding the microphone, and the banner says so.
  window.setTimeout(() => {
    if (meeting.self.audioTrack !== after || call.finishing) return
    const stuck = microphoneStatus(meeting) === 'muted'
    call.stuckMuted = stuck
    note('mic:result', { trigger, id: after?.id.slice(0, 8), newTrack: after !== before, stuck })
    syncSelfControls()
    if (stuck || trigger === 'tap') void sendDiagnostics(stuck ? 'still-muted' : 'recovered')
  }, MUTE_SETTLE_MS)
}

/** The mute button. A deliberate mute is remembered, so the banner stays quiet. */
export async function toggleMicrophone(): Promise<void> {
  const meeting = call.meeting
  if (!meeting || call.recovering) return
  if (meeting.self.audioEnabled) {
    call.selfMuted = true
    try {
      await meeting.self.disableAudio()
    } catch (error) {
      call.lastMediaError = describe(error)
    }
    micMeter.attach(null)
    syncSelfControls()
    return
  }
  call.selfMuted = false
  await ensureMicrophone('tap')
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

/** The mic and camera buttons, their labels, and the banner. Rendered from state, never assumed. */
export function syncSelfControls(): void {
  const meeting = call.meeting
  if (!meeting) return
  if (call.recovering) {
    // Mid capture the SDK holds no track for a moment. The controls keep
    // saying what they said rather than flashing "off" and back;
    // ensureMicrophone() syncs once the new track is in.
    renderAudioStatus()
    return
  }
  const status = microphoneStatus(meeting)
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

  if (status !== 'muted') call.stuckMuted = false
  const attention = !call.finishing && !call.selfMuted && status !== 'on'
  els.micOff.classList.toggle('hidden', !attention)
  if (attention) {
    const [text, action] = bannerFor(status)
    els.micOffText.textContent = text
    els.micOffFix.textContent = action
  }
  renderAudioStatus()
}

function bannerFor(status: MicrophoneStatus): [text: string, action: string] {
  if (status === 'muted') {
    return call.stuckMuted
      ? [`The system keeps muting your microphone. ${systemMuteHint()} Then try again, or reload the page.`, 'Try again']
      : ['The system muted your microphone — the other side cannot hear you.', 'Fix microphone']
  }
  if (call.lastMediaError) return [`Your microphone is off. ${call.lastMediaError}`, 'Turn it on']
  if (status === 'ended') return ['Your microphone stopped — the other side cannot hear you.', 'Turn it on']
  return ['Your microphone is off — the other side cannot hear you.', 'Turn it on']
}

function setBusy(busy: boolean): void {
  els.micOffFix.disabled = busy
  // The mute button too: a tap mid capture would race the SDK.
  els.mic.disabled = busy
}

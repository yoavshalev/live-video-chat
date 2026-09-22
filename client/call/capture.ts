/**
 * The microphone as the SDK actually has it, and how to get a fresh one.
 *
 * What the SDK reports and what it holds are different things. `audioEnabled`
 * is a flag on whatever track it has; the track underneath can be muted by
 * the platform (`track.muted`, which no page can clear), ended by it, or
 * missing because a capture failed — and the SDK swallows failed captures
 * rather than throwing (@cloudflare/realtimekit 2.0.2). So the status here is
 * read off the track, and every capture is verified rather than assumed.
 *
 * The SDK's enableAudio() with no argument only flips the flag on the track
 * it holds; it captures only when it holds none. Its setDevice() stops the
 * track and captures afresh. Handing it a track of our own (enableAudio(track))
 * makes it publish that one. Those three facts are all this module relies on.
 */

import { describe } from './boot'
import { note } from './diagnostics'
import { allowMicrophoneHint, isIOS } from './platform'
import type { RtkMeeting } from './sdk'
import { call } from './state'

export type MicrophoneStatus =
  /** A live track, enabled, carrying sound as far as the browser can tell. */
  | 'on'
  /** A live track the SDK has disabled: a mute, ours or the SDK's. */
  | 'off'
  /** A live, enabled track the platform has muted. Only a fresh capture helps. */
  | 'muted'
  /** The track ended underneath the SDK. Only a fresh capture helps. */
  | 'ended'
  /** The SDK holds no microphone at all. */
  | 'absent'

export function microphoneStatus(meeting: RtkMeeting): MicrophoneStatus {
  const track = meeting.self.audioTrack
  if (!track) return 'absent'
  if (track.readyState === 'ended') return 'ended'
  if (!meeting.self.audioEnabled) return 'off'
  if (track.muted) return 'muted'
  return 'on'
}

export type CaptureResult = { ok: true } | { ok: false; reason: string }

/**
 * A fresh capture, handed to the SDK so it publishes the new track.
 *
 * Through the SDK's own device switch where a capture may start on its own.
 * Through our own getUserMedia on iOS — where a capture belongs inside the
 * tap that asked for it, and where a refusal has to be read by us because the
 * SDK would swallow it — and anywhere the SDK came back empty-handed.
 */
export async function captureMicrophone(meeting: RtkMeeting): Promise<CaptureResult> {
  const before = meeting.self.audioTrack ?? null
  const device = meeting.self.getCurrentDevices().audio ?? call.microphones[0]

  if (device && !isIOS) {
    await meeting.self.setDevice({ ...device, kind: 'audioinput' })
    if (freshLiveTrack(meeting, before)) return { ok: true }
    note('capture:setDevice-left-no-track')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    return { ok: false, reason: explainCaptureError(error) }
  }
  const [fresh] = stream.getAudioTracks()
  if (!fresh) return { ok: false, reason: 'The browser returned no microphone.' }

  // Order matters. The SDK treats a handed-over track as custom and never stops
  // the previous one itself; and stopping the previous one before the SDK has
  // let go of it would fire the SDK's own "ended" handler, which captures yet
  // another track behind our back.
  const old = meeting.self.audioTrack ?? null
  await meeting.self.disableAudio()
  await meeting.self.enableAudio(fresh)
  if (old && old !== fresh) old.stop()

  if (freshLiveTrack(meeting, before)) return { ok: true }
  fresh.stop()
  return { ok: false, reason: 'The call could not switch to the new microphone.' }
}

function freshLiveTrack(meeting: RtkMeeting, before: MediaStreamTrack | null): boolean {
  const track = meeting.self.audioTrack
  return Boolean(track && track !== before && track.readyState === 'live')
}

/** What a refused getUserMedia means, in words that say what to do about it, here. */
function explainCaptureError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? ''
  note('getUserMedia:error', { name, message: describe(error) })
  if (name === 'NotAllowedError' || name === 'SecurityError') return `The browser has blocked the microphone. ${allowMicrophoneHint()}`
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app or tab is using the microphone. Close it, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.'
  return describe(error)
}

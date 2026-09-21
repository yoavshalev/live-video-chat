/**
 * The call page's mutable state, in one place so every module reads and writes
 * the same object rather than a copy. Nothing here is persisted.
 */

import type { RtkDevice, RtkMeeting, RtkParticipant } from './sdk'

export const call = {
  meeting: null as RtkMeeting | null,
  remoteParticipant: null as RtkParticipant | null,
  /** We are in the room. */
  joined: false,
  /** finish() has begun; nothing may restart timers or re-show controls. */
  finishing: false,
  /** The parent has been told media-joined, so it must also be told media-left. */
  reported: false,
  /** The person pressed mute themselves, as opposed to the SDK having no microphone. */
  selfMuted: false,
  /** The last thing the SDK said went wrong with a device, for the status line. */
  lastMediaError: null as string | null,

  // Output device.
  /** The output we want, applied to every audio element as it gets a stream. */
  wantedSinkId: null as string | null,
  sinkError: null as string | null,

  // Microphone recovery (see microphone.ts).
  autoRecovered: false,
  recovering: false,

  // What the browser offers, refreshed on devicechange.
  cameras: [] as RtkDevice[],
  microphones: [] as RtkDevice[],
  speakers: [] as MediaDeviceInfo[]
}

/** Chrome, Edge and Firefox let a page pick the output device; Safari does not. */
export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

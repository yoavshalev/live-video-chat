/**
 * Belt and braces for audio, once a second while in the call.
 *
 * Events tell us when tracks change, but the SDK can hand over a participant
 * before its track exists, or swap a track without an event we listen for. So
 * what is playing is made to match what the SDK currently holds; every step is
 * idempotent, so a reconcile that finds nothing changed does nothing.
 */

import { els } from './dom'
import { call } from './state'
import { micMeter } from './meters'
import { recoverMicrophone, selfTrackMuted, syncSelfControls } from './microphone'
import { syncPeerAudio } from './peer'
import { renderAudioStatus } from './status'

export function reconcileAudio(): void {
  const meeting = call.meeting
  if (!meeting) return

  const own = meeting.self.audioTrack ?? null
  if (meeting.self.audioEnabled && own && selfTrackMuted() && !call.autoRecovered && !call.recovering) {
    // First sight of a platform-muted track: fix it without asking, once. If
    // the re-acquired track is muted too, the banner and its button take over.
    call.autoRecovered = true
    void recoverMicrophone()
    return
  }
  micMeter.attach(meeting.self.audioEnabled ? own : null)
  syncPeerAudio()

  // Cheap, and the buttons must never drift from the SDK again.
  if (els.mic.classList.contains('off') === meeting.self.audioEnabled) syncSelfControls()
  else renderAudioStatus()
}

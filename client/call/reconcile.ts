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
import { recordAutomatic, shouldAutoRecover } from './recovery'
import { renderAudioStatus } from './status'

export function reconcileAudio(): void {
  const meeting = call.meeting
  if (!meeting) return

  const own = meeting.self.audioTrack ?? null
  if (meeting.self.audioEnabled && own && selfTrackMuted()) {
    // A platform-muted track. Muted for long enough to be real, in the
    // foreground, and not too often: fix it without asking. Otherwise the
    // banner and its button take over.
    const now = Date.now()
    call.recovery.mutedSince ??= now
    if (!call.recovering && shouldAutoRecover(call.recovery, now, document.visibilityState === 'visible')) {
      call.recovery = recordAutomatic(call.recovery, now)
      void recoverMicrophone('auto')
      return
    }
  } else if (!call.recovering) {
    call.recovery.mutedSince = null
  }
  micMeter.attach(meeting.self.audioEnabled ? own : null)
  syncPeerAudio()

  // Cheap, and the buttons must never drift from the SDK again.
  if (els.mic.classList.contains('off') === meeting.self.audioEnabled) syncSelfControls()
  else renderAudioStatus()
}

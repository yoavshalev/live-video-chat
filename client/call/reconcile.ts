/**
 * Belt and braces for audio, once a second while in the call.
 *
 * Events tell us when tracks change, but the SDK can hand over a participant
 * before its track exists, or swap a track without an event we listen for. So
 * what is playing is made to match what the SDK currently holds; every step is
 * idempotent, so a reconcile that finds nothing changed does nothing.
 */

import { microphoneStatus } from './capture'
import { els } from './dom'
import { micMeter } from './meters'
import { ensureMicrophone, syncSelfControls } from './microphone'
import { syncPeerAudio } from './peer'
import { isIOS } from './platform'
import { recordAutomatic, shouldAutoRecover } from './recovery'
import { call } from './state'
import { renderAudioStatus } from './status'

export function reconcileAudio(): void {
  const meeting = call.meeting
  if (!meeting) return

  // A microphone we had and lost — muted or ended by the platform — and that
  // nobody muted on purpose. Fixed without asking where a capture may start on
  // its own: not on iOS, where one started outside a tap can put a permission
  // prompt in front of somebody who did not ask for it, and a dismissed prompt
  // is a denial for the rest of the page. There, and beyond the policy's
  // limits, the banner and its button take over.
  const status = microphoneStatus(meeting)
  if (!call.selfMuted && (status === 'muted' || status === 'ended')) {
    const now = Date.now()
    call.recovery.mutedSince ??= now
    if (!call.recovering && !isIOS && shouldAutoRecover(call.recovery, now, document.visibilityState === 'visible')) {
      call.recovery = recordAutomatic(call.recovery, now)
      void ensureMicrophone('auto')
      return
    }
  } else if (!call.recovering) {
    call.recovery.mutedSince = null
  }

  micMeter.attach(meeting.self.audioEnabled ? (meeting.self.audioTrack ?? null) : null)
  syncPeerAudio()

  // Cheap, and the buttons must never drift from the SDK again.
  if (els.mic.classList.contains('off') === meeting.self.audioEnabled) syncSelfControls()
  else renderAudioStatus()
}

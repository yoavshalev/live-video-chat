/**
 * The 1:1 call, driven by the RealtimeKit Core SDK.
 *
 * Runs on /call, which is loaded in a same-origin-to-us iframe inside the widget
 * (visitor) or the dashboard (host). Both sides run this same bundle; `who`
 * decides which participant token is redeemed and which peer name is shown.
 *
 * Audio is the part that goes wrong in practice ("I can't hear you"), and it
 * goes wrong in places that look identical from the other end: their
 * microphone never got into the call, they are muted, their device is silent,
 * your output is the wrong device, autoplay was refused. So both sides get the
 * same instruments — their own microphone state read from the SDK, level
 * meters, a speaker picker, a status line that says which of these it is.
 *
 * Modules:
 *   lifecycle.ts   set up → join → finish
 *   capture.ts     what the SDK really holds, and a verified fresh capture
 *   microphone.ts  our own mic and camera: intent, status, and the banner
 *   recovery.ts    when a lost microphone is re-captured on its own (pure)
 *   platform.ts    where we run, and the per-browser words for a blocked mic
 *   devices.ts     pickers, remembered defaults, the output device
 *   peer.ts        the other person's video, audio and screen
 *   meters.ts      level meters, reading the SDK's own tracks
 *   status.ts      the audio status line
 *   reconcile.ts   the once-a-second "make playback match the SDK"
 *   screens.ts     the overlay and its errors
 *   parent.ts      telling the widget or dashboard what happened
 */

import { els } from './dom'
import { call } from './state'
import { notifyParent } from './parent'
import { resumeAudio, syncMeterLabels, whenMetersChange } from './meters'
import { renderAudioStatus } from './status'
import { ensureMicrophone } from './microphone'
import { wireDevices } from './devices'
import { wireHearButton } from './peer'
import { finish, setup } from './lifecycle'

// Browsers start the meters' AudioContext suspended until a gesture lands in
// this frame; the first one resumes it.
window.addEventListener('pointerdown', resumeAudio, { capture: true })
window.addEventListener('keydown', resumeAudio, { capture: true })
whenMetersChange(() => {
  syncMeterLabels()
  renderAudioStatus()
})

wireDevices()
wireHearButton()
els.micOffFix.onclick = () => {
  call.selfMuted = false
  void ensureMicrophone('tap')
}
els.leave.onclick = () => void finish('ended')
els.retry.onclick = () => void setup()
els.abandon.onclick = () => void finish('ended')

// A tab closed mid-call should tell the server immediately rather than waiting
// out the reconnect window while the other person stares at a frozen frame.
window.addEventListener('pagehide', () => {
  if (call.reported && !call.finishing) notifyParent('media-left')
})

void setup()

export {}

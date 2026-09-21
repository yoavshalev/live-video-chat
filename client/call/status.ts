/**
 * The one line that says what is wrong with the audio, and on which side:
 * "Your mic: on — Shure MVX2U. Speaker: Realtek. Them: arriving and playing."
 */

import { els, type Sinkable } from './dom'
import { call, canPickSpeaker } from './state'
import { metersLive, micMeter, remoteMeter } from './meters'

export function renderAudioStatus(): void {
  const meeting = call.meeting
  if (!meeting) return

  const mic = meeting.self.getCurrentDevices().audio?.label
  const you = meeting.self.audioEnabled
    ? `on${mic ? ` — ${mic}` : ''}${!metersLive() ? ' (meter starts after a tap in the call)' : micMeter.level === 0 && call.joined ? ' (nothing heard yet — say something)' : ''}`
    : call.selfMuted
      ? 'muted by you'
      : `OFF — ${call.lastMediaError ?? 'the browser did not hand over a microphone'}`

  const sink = (els.remoteAudio as Sinkable).sinkId || call.wantedSinkId || ''
  const speakerLabel = call.speakers.find((d) => d.deviceId === sink)?.label
  const speaker = !canPickSpeaker
    ? 'system default (this browser cannot choose)'
    : call.sinkError
      ? `system default — could not switch: ${call.sinkError}`
      : speakerLabel ?? 'system default'

  const peer = call.remoteParticipant
  const them = !call.joined
    ? 'not connected yet'
    : !peer
      ? 'not in the room yet'
      : peer.audioEnabled === false
        ? 'their microphone is off on their side'
        : !peer.audioTrack
          ? 'on, but no audio has arrived yet'
          : els.remoteAudio.paused
            ? 'arriving, but playback is blocked — use "Tap to hear"'
            : metersLive() && remoteMeter.level === 0
              ? 'arriving and playing (silent right now)'
              : 'arriving and playing'

  els.audioStatus.textContent = `Your mic: ${you}. Speaker: ${speaker}. Them: ${them}.`
}

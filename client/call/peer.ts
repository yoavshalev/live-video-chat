/**
 * The other person: their video, their audio (which WE play — the core SDK
 * hands over a raw track and plays nothing), their screen, and what to tell
 * them when their microphone is off.
 */

import { boot } from './boot'
import { els, type Sinkable } from './dom'
import { call } from './state'
import { remoteMeter, resumeAudio } from './meters'
import { applySink } from './devices'
import { renderAudioStatus } from './status'
import { showWaitingForPeer } from './screens'
import type { RtkParticipant } from './sdk'

const attached = new WeakMap<HTMLMediaElement, MediaStreamTrack | null>()

/**
 * A MediaStreamTrack makes no sound on its own; it has to be wrapped in a
 * MediaStream and handed to an element. The same track object is reused when
 * nothing changed, so a mute/unmute does not restart playback.
 */
function playInto(element: HTMLMediaElement, track: MediaStreamTrack | null): void {
  if (attached.get(element) === track) return
  attached.set(element, track)
  if (!track) {
    element.srcObject = null
    return
  }
  element.srcObject = new MediaStream([track])
  void applySink(element as Sinkable)
  console.info(`[call] playing ${element.id}`, track.label || track.id)
  element.play().catch(() => {
    // Refused: the browser wants a gesture on THIS document first. The Join
    // click normally provides one, but not after a reload straight into a live
    // call. One tap fixes it, so offer exactly that.
    els.hear.classList.remove('hidden')
    renderAudioStatus()
  })
}

export function playRemoteAudio(track: MediaStreamTrack | null): void {
  playInto(els.remoteAudio, track)
}

export function showRemoteShare(track: MediaStreamTrack | null, audio: MediaStreamTrack | null = null): void {
  if (track) {
    els.share.srcObject = new MediaStream([track])
    els.share.classList.remove('hidden')
    els.stage.classList.add('sharing')
    void els.share.play().catch(() => {})
  } else {
    els.share.srcObject = null
    els.share.classList.add('hidden')
    els.stage.classList.remove('sharing')
  }
  playInto(els.shareAudio, audio)
}

/** Their name on the stage, and — when their microphone is off — what to ask them to tap. */
export function labelPeer(participant: RtkParticipant): void {
  const name = participant.name || boot.peerName || 'Connected'
  const muted = participant.audioEnabled === false
  els.peerName.textContent = muted ? `${name} · mic off` : name
  els.remoteLevelLabel.textContent = muted ? `${name} (mic off)` : `${name} — what is arriving`
  // Their screen shows a banner with the fix; this is what to say out loud.
  els.peerHint.textContent = muted
    ? `${name}'s microphone is off on their side. Ask them to tap the red "Turn it on" / "Fix microphone" button at the top of their screen, or "Unmute" at the bottom.`
    : ''
  els.peerHint.classList.toggle('hidden', !muted)
}

/** Makes what is playing match what the SDK currently holds for the other side. */
export function syncPeerAudio(): void {
  const peer = call.remoteParticipant
  if (!peer) return
  const track = peer.audioEnabled === false ? null : (peer.audioTrack ?? null)
  playRemoteAudio(track)
  remoteMeter.attach(track)
  labelPeer(peer)
}

/** Subscribes to the room's participant events. Once, right after join. */
export function wireParticipants(): void {
  const meeting = call.meeting
  if (!meeting) return
  const attach = (participant: RtkParticipant) => {
    call.remoteParticipant = participant
    participant.registerVideoElement(els.remote)
    // Video is attached by the SDK helper above. Audio is not — without the
    // next line the call is silent.
    syncPeerAudio()
    els.peerName.classList.remove('hidden')
    showWaitingForPeer(false)
    renderAudioStatus()
  }

  // Someone may already be in the room — the other side usually arrives first.
  const existing = meeting.participants.joined.toArray()
  if (existing.length > 0 && existing[0]) attach(existing[0])
  else showWaitingForPeer(true)

  meeting.participants.joined.on('participantJoined', attach)
  meeting.participants.joined.on('videoUpdate', (participant) => {
    if (participant.id === call.remoteParticipant?.id) participant.registerVideoElement(els.remote)
  })
  // Fires when the other side mutes, unmutes, or their track is (re)negotiated —
  // each of those can hand us a different MediaStreamTrack object.
  meeting.participants.joined.on('audioUpdate', (participant) => {
    if (participant.id !== call.remoteParticipant?.id) return
    call.remoteParticipant = participant
    syncPeerAudio()
  })
  meeting.participants.joined.on('participantLeft', (participant) => {
    if (participant.id !== call.remoteParticipant?.id) return
    call.remoteParticipant = null
    playRemoteAudio(null)
    remoteMeter.detach()
    showRemoteShare(null)
    els.peerHint.classList.add('hidden')
    // Not the end of the call: the server's reconnect window decides that. A
    // dropped connection on a train should not hang up on someone.
    showWaitingForPeer(true)
    renderAudioStatus()
  })

  // The other side's screen. A screen track is a plain MediaStreamTrack, so it
  // goes on its own <video> rather than through registerVideoElement.
  const syncShare = (participant: RtkParticipant) => {
    if (participant.id !== call.remoteParticipant?.id) return
    const on = participant.screenShareEnabled
    showRemoteShare(
      on ? (participant.screenShareTracks?.video ?? null) : null,
      on ? (participant.screenShareTracks?.audio ?? null) : null
    )
  }
  meeting.participants.joined.on('screenShareUpdate', syncShare)
  if (existing[0]) syncShare(existing[0])
}

/** The "Tap to hear" button, for browsers that refused to start audio without a gesture. */
export function wireHearButton(): void {
  els.hear.onclick = () => {
    els.hear.classList.add('hidden')
    resumeAudio()
    for (const element of [els.remoteAudio, els.shareAudio]) {
      if (element.srcObject) void element.play().catch(() => els.hear.classList.remove('hidden'))
    }
    renderAudioStatus()
  }
}

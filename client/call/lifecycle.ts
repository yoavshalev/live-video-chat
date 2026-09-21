/**
 * The call from start to finish: set up (credentials, SDK, the camera check),
 * join, and end.
 *
 * Order of operations matters and is the whole reason this is a separate page:
 *
 *   1. Redeem the call secret for a participant authToken. Nothing has touched a
 *      camera yet.
 *   2. `RealtimeKitClient.init` — THIS is where the browser prompts for camera
 *      and microphone, on a screen whose only content is that request, after the
 *      person deliberately clicked "Join".
 *   3. Show the preview, device pickers and a microphone meter. Still not in
 *      the room. (An agent who has asked to skip this step joins right here.)
 *   4. `meeting.join()` on an explicit second click.
 *
 * Asking for permissions any earlier — on page load, or when someone joins the
 * queue — produces denials, and a denial in Chrome is remembered for the origin.
 * One badly-timed prompt costs every future call from that browser.
 */

import { boot, describe } from './boot'
import { els } from './dom'
import { call } from './state'
import { fetchCredentials, loadSdk } from './sdk'
import { notifyParent } from './parent'
import { clearError, framePermitsMedia, handleMediaError, hideSetup, showError, showOverlay } from './screens'
import { micMeter, remoteMeter, resumeAudio, syncMeterLabels } from './meters'
import { syncSelfControls, wireSelf } from './microphone'
import { applyRememberedDevices, refreshDevices, toggleSettings } from './devices'
import { playRemoteAudio, showRemoteShare, wireParticipants } from './peer'
import { reconcileAudio } from './reconcile'
import { wireControls } from './controls'
import { loadPrefs } from '../shared/prefs'

let startedAt = 0
let ticker: ReturnType<typeof setInterval> | null = null
let reconciler: ReturnType<typeof setInterval> | null = null

export async function setup(): Promise<void> {
  clearError()
  showOverlay('Getting ready…', 'Setting up your call.')

  if (!window.isSecureContext) {
    showError('Video calls need a secure (https) connection.')
    return
  }
  if (!framePermitsMedia()) {
    notifyParent('iframe-blocked')
    showError('Your browser will not allow the camera inside this page. Opening the call in its own tab fixes it.', {
      newTab: true
    })
    return
  }

  let credentials: { authToken: string; displayName: string }
  try {
    credentials = await fetchCredentials()
  } catch (error) {
    showError(describe(error), { retry: true })
    return
  }

  try {
    await loadSdk()
  } catch (error) {
    showError(describe(error), { retry: true })
    return
  }

  showOverlay('Camera and microphone', 'Say something — the bar under the microphone should move.')
  try {
    // The permission prompt happens inside this call.
    call.meeting = await window.RealtimeKitClient!.init({
      authToken: credentials.authToken,
      defaults: { audio: true, video: true }
    })
  } catch (error) {
    handleMediaError(error)
    return
  }
  const meeting = call.meeting

  wireSelf()
  els.preview.classList.remove('hidden')
  // Lays the overlay out around the preview (beside the pickers on a wide stage).
  els.overlay.classList.add('setup')
  // `true` marks this as a local preview that is not published to the room.
  meeting.self.registerVideoElement(els.preview, true)
  await refreshDevices()
  await applyRememberedDevices()
  micMeter.attach(meeting.self.audioTrack ?? null)
  syncMeterLabels()
  syncSelfControls()

  els.join.classList.remove('hidden')
  els.join.textContent = boot.who === 'host' ? 'Join the call' : `Join ${boot.peerName || credentials.displayName}`
  els.join.onclick = () => void join()
  els.join.focus()

  // Agents take many calls; the check screen is theirs to skip. Visitors get
  // it every time — it is also the moment their browser asks for permission.
  if (boot.who === 'host') {
    els.autoJoinWrap.classList.remove('hidden')
    els.autoJoinCallWrap.classList.remove('hidden')
    const auto = Boolean(loadPrefs().autoJoin)
    els.autoJoin.checked = auto
    els.autoJoinCall.checked = auto
    if (auto && meeting.self.audioEnabled && meeting.self.videoEnabled) void join()
  }
}

export async function join(): Promise<void> {
  const meeting = call.meeting
  if (!meeting || call.joined) return
  els.join.disabled = true
  els.join.textContent = 'Connecting…'
  showOverlay('Connecting…', 'One moment.')
  resumeAudio()

  try {
    await meeting.join()
  } catch (error) {
    els.join.disabled = false
    els.join.textContent = 'Join the call'
    handleMediaError(error)
    return
  }
  call.joined = true

  meeting.self.deregisterVideoElement(els.preview)
  els.preview.classList.add('hidden')
  els.local.classList.remove('hidden')
  meeting.self.registerVideoElement(els.local, true)

  els.overlay.classList.add('hidden')
  els.overlay.classList.remove('setup')
  els.controls.hidden = false
  els.timer.classList.remove('hidden')

  startedAt = Date.now()
  ticker = setInterval(updateTimer, 1000)
  updateTimer()

  wireParticipants()
  wireControls()
  syncSelfControls()

  call.reported = true
  notifyParent('media-joined')

  reconciler = setInterval(reconcileAudio, 1000)

  meeting.self.on('roomLeft', () => void finish('left'))
}

function updateTimer(): void {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const minutes = Math.floor(seconds / 60)
  els.elapsed.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Ends this side of the call.
 *
 * The parent is told FIRST and the room is left second, with a cap on how
 * long we wait. `meeting.leave()` can take seconds, or never settle when the
 * media connection is already gone — and while it was awaited, the "ended"
 * message never went out, the server never ended the call, and both sides sat
 * on a frozen screen with no way out. Nothing the parent does depends on the
 * room actually having been left.
 */
export async function finish(type: 'ended' | 'left'): Promise<void> {
  if (call.finishing) return
  call.finishing = true

  if (ticker) clearInterval(ticker)
  ticker = null
  if (reconciler) clearInterval(reconciler)
  reconciler = null
  els.controls.hidden = true
  els.timer.classList.add('hidden')
  els.micOff.classList.add('hidden')
  toggleSettings(false)

  if (call.reported) notifyParent('media-left')
  if (type === 'ended') notifyParent('ended')

  micMeter.detach()
  remoteMeter.detach()
  playRemoteAudio(null)
  showRemoteShare(null)

  clearError()
  hideSetup()
  showOverlay('Call ended', 'Thanks for the conversation.')

  await Promise.race([
    (call.meeting?.leave() ?? Promise.resolve()).catch(() => {
      /* already gone */
    }),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
}

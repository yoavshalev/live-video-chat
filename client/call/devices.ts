/**
 * Cameras, microphones and speakers: the pickers on the pre-call screen and
 * in the settings panel (filled from the same lists, so a pick in either place
 * does the same thing), the remembered per-browser defaults, and the output
 * device — which has to be re-applied whenever an audio element gets a stream.
 */

import { describe } from './boot'
import { els, type Sinkable } from './dom'
import { call, canPickSpeaker } from './state'
import { micMeter } from './meters'
import { syncSelfControls } from './microphone'
import { renderAudioStatus } from './status'
import type { RtkDevice } from './sdk'
import { loadPrefs, pickRemembered, savePrefs } from '../shared/prefs'
import { playTestTone } from '../shared/tone'

/** Re-run when the browser reports a device change (a headset plugged in). */
export async function refreshDevices(): Promise<void> {
  const meeting = call.meeting
  if (!meeting) return
  try {
    ;[call.cameras, call.microphones] = await Promise.all([meeting.self.getVideoDevices(), meeting.self.getAudioDevices()])
    const current = meeting.self.getCurrentDevices()

    for (const select of [els.cameraSelect, els.callCam]) fillSelect(select, call.cameras, current.video?.deviceId)
    for (const select of [els.micSelect, els.callMic]) fillSelect(select, call.microphones, current.audio?.deviceId)
    els.devices.classList.remove('hidden')

    if (canPickSpeaker) {
      call.speakers = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
      const chosen = call.wantedSinkId ?? ((els.remoteAudio as Sinkable).sinkId || 'default')
      const selected = call.speakers.some((d) => d.deviceId === chosen) ? chosen : call.speakers[0]?.deviceId
      const options = call.speakers.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind }))
      for (const select of [els.callSpeaker, els.previewSpeaker]) fillSelect(select, options, selected)
      els.speakerWrap.classList.toggle('hidden', call.speakers.length === 0)
      els.previewSpeakerWrap.classList.toggle('hidden', call.speakers.length === 0)
    }
  } catch {
    // Device labels are unavailable until permission is granted in some browsers.
    // Not being able to choose is a small loss; failing the call is not.
  }
}

/** Starts from what this browser used last time, when those devices are still here. */
export async function applyRememberedDevices(): Promise<void> {
  const meeting = call.meeting
  if (!meeting) return
  const prefs = loadPrefs()
  const current = meeting.self.getCurrentDevices()
  const mic = pickRemembered(call.microphones, prefs.audioinput)
  if (mic && mic.deviceId !== current.audio?.deviceId) await switchDevice(call.microphones, mic.deviceId, false)
  const cam = pickRemembered(call.cameras, prefs.videoinput)
  if (cam && cam.deviceId !== current.video?.deviceId) await switchDevice(call.cameras, cam.deviceId, false)
  if (canPickSpeaker) {
    const speaker = pickRemembered(call.speakers, prefs.audiooutput)
    if (speaker) await switchSpeaker(speaker.deviceId, false)
  }
}

function fillSelect(select: HTMLSelectElement, devices: RtkDevice[], selected?: string): void {
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label || `${select.id.includes('mic') ? 'Microphone' : select.id.includes('speaker') ? 'Speaker' : 'Camera'} ${index + 1}`
      if (device.deviceId === selected) option.selected = true
      return option
    })
  )
}

export async function switchDevice(devices: RtkDevice[], deviceId: string, remember = true): Promise<void> {
  const device = devices.find((candidate) => candidate.deviceId === deviceId)
  const meeting = call.meeting
  if (!device || !meeting) return
  try {
    await meeting.self.setDevice(device)
  } catch (error) {
    els.settingsHint.textContent = `Could not switch: ${describe(error)}`
    return
  }
  // The SDK swaps the track under us; the meter follows, and the other picker
  // for the same kind is kept in step.
  const isCamera = device.kind === 'videoinput'
  for (const select of isCamera ? [els.cameraSelect, els.callCam] : [els.micSelect, els.callMic]) select.value = deviceId
  if (remember) savePrefs({ [isCamera ? 'videoinput' : 'audioinput']: { id: device.deviceId, label: device.label } })
  micMeter.attach(meeting.self.audioTrack ?? null)
  syncSelfControls()
}

export async function switchSpeaker(deviceId: string, remember = true): Promise<void> {
  call.wantedSinkId = deviceId
  for (const select of [els.callSpeaker, els.previewSpeaker]) select.value = deviceId
  const chosen = call.speakers.find((d) => d.deviceId === deviceId)
  if (remember && chosen) savePrefs({ audiooutput: { id: chosen.deviceId, label: chosen.label } })
  await Promise.all(([els.remoteAudio, els.shareAudio] as Sinkable[]).map((element) => applySink(element)))
  const hint = call.sinkError ? `Could not switch speaker: ${call.sinkError}` : ''
  els.settingsHint.textContent = hint
  els.previewSpeakerHint.textContent = hint
  renderAudioStatus()
}

/**
 * Points one audio element at the wanted output. Called on every stream
 * attach as well as on a pick, because a sink set before an element had a
 * stream did not survive in every browser — which is how a call opened on
 * the headset after the desk speaker had been chosen.
 */
export async function applySink(element: Sinkable): Promise<void> {
  if (!call.wantedSinkId || typeof element.setSinkId !== 'function') return
  if (element.sinkId === call.wantedSinkId) return
  try {
    await element.setSinkId(call.wantedSinkId)
    call.sinkError = null
  } catch (error) {
    call.sinkError = describe(error)
    console.warn('[call] setSinkId failed', call.wantedSinkId, error)
  }
}

export function toggleSettings(open?: boolean): void {
  const show = open ?? els.settings.classList.contains('hidden')
  els.settings.classList.toggle('hidden', !show)
  els.settingsButton.setAttribute('aria-expanded', String(show))
  if (show) {
    void refreshDevices()
    renderAudioStatus()
    els.settingsHint.textContent = canPickSpeaker
      ? ''
      : 'This browser does not let a page choose the speaker; use the system sound settings.'
  }
}

/** Rings the chosen output so the answer to "which speaker?" is "that one". */
async function testSpeaker(button: HTMLButtonElement, select: HTMLSelectElement, again: string): Promise<void> {
  button.disabled = true
  button.textContent = 'Playing…'
  const result = await playTestTone(select.value)
  button.textContent = result === 'played' ? again : 'Could not play'
  button.disabled = false
}

/** Every picker, test button and the settings toggle. Once, at start-up. */
export function wireDevices(): void {
  els.cameraSelect.onchange = () => void switchDevice(call.cameras, els.cameraSelect.value)
  els.micSelect.onchange = () => void switchDevice(call.microphones, els.micSelect.value)
  els.callCam.onchange = () => void switchDevice(call.cameras, els.callCam.value)
  els.callMic.onchange = () => void switchDevice(call.microphones, els.callMic.value)
  els.callSpeaker.onchange = () => void switchSpeaker(els.callSpeaker.value)
  els.previewSpeaker.onchange = () => void switchSpeaker(els.previewSpeaker.value)
  els.callSpeakerTest.onclick = () => void testSpeaker(els.callSpeakerTest, els.callSpeaker, 'Test again')
  els.previewSpeakerTest.onclick = () => void testSpeaker(els.previewSpeakerTest, els.previewSpeaker, 'Heard it? Test again')
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices())

  for (const box of [els.autoJoin, els.autoJoinCall]) {
    box.onchange = () => {
      savePrefs({ autoJoin: box.checked })
      els.autoJoin.checked = box.checked
      els.autoJoinCall.checked = box.checked
    }
  }

  els.settingsButton.onclick = () => toggleSettings()
  els.settingsClose.onclick = () => toggleSettings(false)
}

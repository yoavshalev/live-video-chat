/**
 * The 1:1 call, driven by the RealtimeKit Core SDK.
 *
 * Runs on /call, which is loaded in a same-origin-to-us iframe inside the widget
 * (visitor) or the dashboard (host). Both sides run this same file; `who`
 * decides which participant token is redeemed and which peer name is shown.
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
 *
 * Audio is the part that goes wrong in practice ("I can't hear you"), and it
 * goes wrong in places that look identical from the other end: their
 * microphone never got into the call, they are muted, their device is silent,
 * your output is the wrong device, autoplay was refused. So both sides get the
 * same instruments: their OWN microphone state, read from the SDK rather than
 * assumed (a microphone the browser refused shows as off here, with a button to
 * try again, instead of only as "muted" on the other side); a level meter for
 * it; a meter for what is arriving from the other person; a speaker picker
 * where the browser allows one; and a status line that says which of these it
 * is.
 */

import { loadPrefs, pickRemembered, savePrefs } from '../shared/prefs'
import { playTestTone } from '../shared/tone'

interface Boot {
  callId: string
  secret: string
  who: 'host' | 'visitor'
  visitorId: string | null
  peerName: string
  sdkUrl: string
  /** Validated server-side; the exact origin of the page framing us. */
  parentOrigin: string | null
}

// The Core SDK's surface, narrowed to what this file uses. Typed locally rather
// than pulled from the package because the SDK is loaded at runtime from our own
// /sdk route and never bundled — see src/routes/sdk.ts.
interface RtkDevice {
  deviceId: string
  label: string
  kind: string
}

interface RtkParticipant {
  id: string
  name?: string
  videoEnabled?: boolean
  audioEnabled?: boolean
  /** Raw microphone track. The SDK does NOT play it; we do, in playRemoteAudio. */
  audioTrack?: MediaStreamTrack
  screenShareEnabled?: boolean
  screenShareTracks?: { video?: MediaStreamTrack; audio?: MediaStreamTrack }
  registerVideoElement(element: HTMLVideoElement): void
  deregisterVideoElement?(element: HTMLVideoElement): void
}

interface RtkParticipantMap {
  toArray(): RtkParticipant[]
  get(id: string): RtkParticipant | undefined
  on(event: string, handler: (participant: RtkParticipant) => void): void
}

interface RtkMeeting {
  self: {
    videoEnabled: boolean
    audioEnabled: boolean
    screenShareEnabled: boolean
    roomJoined: boolean
    /** Our own microphone track, replaced when the device changes. */
    audioTrack?: MediaStreamTrack
    enableVideo(): Promise<void>
    disableVideo(): Promise<void>
    enableScreenShare(): Promise<void>
    disableScreenShare(): Promise<void>
    enableAudio(): Promise<void>
    disableAudio(): Promise<void>
    getVideoDevices(): Promise<RtkDevice[]>
    getAudioDevices(): Promise<RtkDevice[]>
    getCurrentDevices(): { audio?: RtkDevice; video?: RtkDevice; speaker?: RtkDevice }
    setDevice(device: RtkDevice): Promise<void>
    registerVideoElement(element: HTMLVideoElement, isPreview?: boolean): void
    deregisterVideoElement(element: HTMLVideoElement): void
    on(event: string, handler: (...args: unknown[]) => void): void
  }
  participants: { joined: RtkParticipantMap }
  join(): Promise<void>
  leave(): Promise<void>
}

declare global {
  interface Window {
    RealtimeKitClient?: {
      init(options: { authToken: string; defaults?: { audio?: boolean; video?: boolean } }): Promise<RtkMeeting>
    }
  }
}

const boot = JSON.parse(document.getElementById('boot')?.textContent ?? '{}') as Boot

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const els = {
  overlay: $<HTMLDivElement>('overlay'),
  title: $<HTMLHeadingElement>('overlay-title'),
  body: $<HTMLParagraphElement>('overlay-body'),
  error: $<HTMLDivElement>('overlay-error'),
  preview: $<HTMLVideoElement>('preview'),
  devices: $<HTMLDivElement>('device-row'),
  cameraSelect: $<HTMLSelectElement>('camera-select'),
  micSelect: $<HTMLSelectElement>('mic-select'),
  previewLevel: $<HTMLElement>('preview-level'),
  autoJoinWrap: $<HTMLElement>('auto-join-wrap'),
  autoJoin: $<HTMLInputElement>('auto-join'),
  join: $<HTMLButtonElement>('btn-join'),
  retry: $<HTMLButtonElement>('btn-retry'),
  abandon: $<HTMLButtonElement>('btn-abandon'),
  newTab: $<HTMLAnchorElement>('btn-newtab'),
  remote: $<HTMLVideoElement>('remote'),
  remoteAudio: $<HTMLAudioElement>('remote-audio'),
  shareAudio: $<HTMLAudioElement>('share-audio'),
  hear: $<HTMLButtonElement>('btn-hear'),
  share: $<HTMLVideoElement>('share'),
  sharePill: $<HTMLDivElement>('share-pill'),
  stage: $<HTMLDivElement>('stage'),
  local: $<HTMLVideoElement>('local'),
  peerName: $<HTMLDivElement>('peer-name'),
  timer: $<HTMLDivElement>('timer'),
  elapsed: $<HTMLSpanElement>('elapsed'),
  micOff: $<HTMLDivElement>('mic-off'),
  micOffText: $<HTMLElement>('mic-off-text'),
  micOffFix: $<HTMLButtonElement>('mic-off-fix'),
  controls: $<HTMLDivElement>('controls'),
  mic: $<HTMLButtonElement>('btn-mic'),
  cam: $<HTMLButtonElement>('btn-cam'),
  shareButton: $<HTMLButtonElement>('btn-share'),
  settingsButton: $<HTMLButtonElement>('btn-settings'),
  leave: $<HTMLButtonElement>('btn-leave'),
  // In-call settings panel.
  settings: $<HTMLDivElement>('settings'),
  settingsClose: $<HTMLButtonElement>('settings-close'),
  audioStatus: $<HTMLElement>('audio-status'),
  callMic: $<HTMLSelectElement>('call-mic'),
  callCam: $<HTMLSelectElement>('call-cam'),
  speakerWrap: $<HTMLDivElement>('speaker-wrap'),
  callSpeaker: $<HTMLSelectElement>('call-speaker'),
  callSpeakerTest: $<HTMLButtonElement>('call-speaker-test'),
  micLevel: $<HTMLElement>('mic-level'),
  remoteLevel: $<HTMLElement>('remote-level'),
  remoteLevelLabel: $<HTMLElement>('remote-level-label'),
  autoJoinCallWrap: $<HTMLElement>('auto-join-call-wrap'),
  autoJoinCall: $<HTMLInputElement>('auto-join-call'),
  settingsHint: $<HTMLElement>('settings-hint')
}

let meeting: RtkMeeting | null = null
let remoteParticipant: RtkParticipant | null = null
let startedAt = 0
let ticker: ReturnType<typeof setInterval> | null = null
let reconciler: ReturnType<typeof setInterval> | null = null
let reported = false
let joined = false
let finishing = false
/** True while the person has muted themselves, as opposed to the SDK having no microphone. */
let selfMuted = false
/** The last thing the SDK said went wrong with a device, for the status line. */
let lastMediaError: string | null = null

// ─── Talking to whoever framed us ────────────────────────────────────────────

/**
 * Media events are relayed to the parent (widget or dashboard), which owns the
 * live socket to the Durable Object. One socket per person, not two.
 *
 * `parentOrigin` was validated server-side against the site's allowed origins, so
 * this is a targeted post, never `'*'`. When we are the top-level tab there is no
 * parent and the HTTP fallback below is used instead.
 */
function notifyParent(type: string): void {
  if (window.self === window.top) {
    void fetch('/api/call/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId: boot.callId,
        secret: boot.secret,
        who: boot.who,
        visitorId: boot.visitorId,
        joined: type === 'media-joined'
      })
    }).catch(() => {})
    return
  }
  try {
    window.parent.postMessage(
      { source: 'founderlive-call', type, callId: boot.callId },
      boot.parentOrigin ?? '*'
    )
  } catch {
    /* the parent went away; the server's own timeouts cover it */
  }
}

// ─── Screens ─────────────────────────────────────────────────────────────────

function showOverlay(title: string, body = ''): void {
  els.overlay.classList.remove('hidden')
  els.title.textContent = title
  els.body.textContent = body
}

function showError(message: string, options: { retry?: boolean; newTab?: boolean } = {}): void {
  els.error.classList.remove('hidden')
  els.error.textContent = message
  els.retry.classList.toggle('hidden', !options.retry)
  els.newTab.classList.toggle('hidden', !options.newTab)
  if (options.newTab) els.newTab.href = location.href
  // Always offered. Whatever went wrong, the visitor must be able to walk away.
  els.abandon.classList.remove('hidden')
  els.join.classList.add('hidden')
  // Tells the widget to put its own close control back, since it hides it for
  // the duration of a call and this call is not going to happen.
  notifyParent('call-error')
}

function clearError(): void {
  els.error.classList.add('hidden')
  els.retry.classList.add('hidden')
  els.newTab.classList.add('hidden')
  els.abandon.classList.add('hidden')
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/**
 * Provisioning runs in parallel with the invitation countdown, so by the time
 * anybody clicks Join the meeting usually exists. "Usually" is not "always",
 * hence the retry on 409 — the alternative is telling someone their call failed
 * when it was simply 300ms early.
 */
async function fetchCredentials(attempt = 0): Promise<{ authToken: string; displayName: string }> {
  const response = await fetch('/api/call/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callId: boot.callId,
      secret: boot.secret,
      who: boot.who,
      visitorId: boot.visitorId
    })
  })

  if (response.status === 409 && attempt < 12) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    return fetchCredentials(attempt + 1)
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `credentials failed (${response.status})`)
  }
  return (await response.json()) as { authToken: string; displayName: string }
}

function loadSdk(): Promise<void> {
  if (window.RealtimeKitClient) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = boot.sdkUrl
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the video SDK.'))
    document.head.append(script)
  })
}

/**
 * Whether this frame is even permitted to ask for a camera.
 *
 * A cross-origin iframe without `allow="camera; microphone"` cannot get media no
 * matter what the visitor clicks, and the failure surfaces as an ordinary
 * permission denial — which would send them to browser settings to fix something
 * that is not broken there. Detecting it up front is what makes the "open in a
 * new tab" escape hatch appear at the right moment.
 */
function framePermitsMedia(): boolean {
  if (window.self === window.top) return true
  try {
    const policy = (document as unknown as { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy
    if (policy?.allowsFeature) {
      return policy.allowsFeature('camera') && policy.allowsFeature('microphone')
    }
  } catch {
    /* not supported here; fall through to the weaker check */
  }
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

// ─── Level meters ────────────────────────────────────────────────────────────
//
// A bar that moves when sound is on a track. Reads the waveform through an
// AnalyserNode on a CLONE of the track: the SDK's own track is never touched
// by anything but the SDK. That matters on iOS, where a captured track goes
// silent the moment a second consumer takes hold of the capture, and where
// "silent" looks, to the other side, exactly like "muted". One AudioContext
// for the page: browsers start it suspended until the person has clicked
// something in THIS frame, so it is resumed on the first gesture (the Join
// click, at the latest).

let audioContext: AudioContext | null = null

function context(): AudioContext | null {
  if (audioContext) return audioContext
  try {
    audioContext = new AudioContext()
  } catch {
    return null
  }
  return audioContext
}

function resumeAudio(): void {
  if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {})
}
window.addEventListener('pointerdown', resumeAudio, { capture: true })
window.addEventListener('keydown', resumeAudio, { capture: true })

class LevelMeter {
  private track: MediaStreamTrack | null = null
  private clone: MediaStreamTrack | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private frame = 0
  /** 0–100, the last reading. Lets the status line say "silent" with evidence. */
  level = 0

  constructor(private readonly bars: HTMLElement[]) {}

  attach(track: MediaStreamTrack | null): void {
    if (track === this.track) return
    this.detach()
    this.track = track
    if (!track || track.readyState === 'ended') return
    const ctx = context()
    if (!ctx) return
    try {
      this.clone = track.clone()
      this.source = ctx.createMediaStreamSource(new MediaStream([this.clone]))
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.source.connect(this.analyser)
    } catch {
      this.detach()
      return
    }
    const samples = new Uint8Array(this.analyser.fftSize)
    const tick = () => {
      if (!this.analyser) return
      this.analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) {
        const deviation = (sample - 128) / 128
        sum += deviation * deviation
      }
      // RMS of speech at a normal distance sits around 0.05–0.2; scaled so
      // talking fills most of the bar and silence shows nothing.
      this.level = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 320))
      for (const bar of this.bars) bar.style.width = `${this.level}%`
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  detach(): void {
    cancelAnimationFrame(this.frame)
    this.source?.disconnect()
    this.analyser?.disconnect()
    // The clone holds the capture open on its own; stopping it is what lets
    // the browser's "microphone in use" indicator go out.
    this.clone?.stop()
    this.source = null
    this.analyser = null
    this.clone = null
    this.track = null
    this.level = 0
    for (const bar of this.bars) bar.style.width = '0%'
  }
}

// The same microphone reading is shown on the preview screen and in the
// settings panel; the remote meter only exists in the panel.
const micMeter = new LevelMeter([els.previewLevel, els.micLevel])
const remoteMeter = new LevelMeter([els.remoteLevel])

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
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
    meeting = await window.RealtimeKitClient!.init({
      authToken: credentials.authToken,
      defaults: { audio: true, video: true }
    })
  } catch (error) {
    handleMediaError(error)
    return
  }

  wireSelf()
  els.preview.classList.remove('hidden')
  // Lays the overlay out around the preview (beside the pickers on a wide stage).
  els.overlay.classList.add('setup')
  // `true` marks this as a local preview that is not published to the room.
  meeting.self.registerVideoElement(els.preview, true)
  await refreshDevices()
  await applyRememberedDevices()
  micMeter.attach(meeting.self.audioTrack ?? null)
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

function handleMediaError(error: unknown): void {
  const name = (error as { name?: string } | null)?.name ?? ''
  const inFrame = window.self !== window.top

  if (name === 'NotAllowedError' || /permission/i.test(describe(error))) {
    notifyParent('iframe-blocked')
    showError(
      inFrame
        ? 'Camera or microphone access was blocked. Allow it for this site, or open the call in its own tab.'
        : 'Camera or microphone access was blocked. Allow it in your browser’s address bar, then try again.',
      { retry: true, newTab: inFrame }
    )
    return
  }
  if (name === 'NotFoundError') {
    showError('No camera or microphone was found on this device.', { retry: true })
    return
  }
  if (name === 'NotReadableError') {
    showError('Your camera is in use by another app. Close it and try again.', { retry: true })
    return
  }
  showError(describe(error), { retry: true, newTab: inFrame })
}

// ─── Our own microphone and camera ───────────────────────────────────────────

/**
 * The SDK is the source of truth for whether our microphone is in the call.
 * `defaults: { audio: true }` is a request, not a promise: the browser can
 * refuse, iOS can hand over a muted track, a device can vanish. The buttons
 * used to assume success and only flip on click, which is how one side sat
 * "unmuted" while the other saw "muted". Now they are read back from the SDK,
 * and a microphone that is off without anyone asking gets a banner.
 */
function wireSelf(): void {
  if (!meeting) return
  const self = meeting.self
  self.on('audioUpdate', () => syncSelfControls())
  self.on('videoUpdate', () => syncSelfControls())
  self.on('deviceUpdate', () => {
    void refreshDevices()
    reconcileAudio()
  })
  self.on('mediaPermissionError', (...args: unknown[]) => {
    const detail = args[0] as { message?: string; kind?: string } | undefined
    lastMediaError = detail?.message ? `${detail.kind ?? 'device'}: ${detail.message}` : 'the browser refused a device'
    console.warn('[call] media permission error', detail)
    syncSelfControls()
  })
}

function syncSelfControls(): void {
  if (!meeting) return
  const audioOn = meeting.self.audioEnabled
  const videoOn = meeting.self.videoEnabled
  els.mic.classList.toggle('off', !audioOn)
  els.mic.setAttribute('aria-pressed', String(!audioOn))
  els.mic.setAttribute('aria-label', audioOn ? 'Mute microphone' : 'Unmute microphone')
  els.cam.classList.toggle('off', !videoOn)
  els.cam.setAttribute('aria-pressed', String(!videoOn))
  els.cam.setAttribute('aria-label', videoOn ? 'Turn camera off' : 'Turn camera on')

  // Off without you asking for it: say so on YOUR screen. The other side only
  // ever sees "muted", which sends them looking in the wrong place.
  const unexpected = !audioOn && !selfMuted && !finishing
  els.micOff.classList.toggle('hidden', !unexpected)
  if (unexpected) {
    els.micOffText.textContent = lastMediaError
      ? `Your microphone is off (${lastMediaError}).`
      : 'Your microphone is off — the other side cannot hear you.'
  }
  renderAudioStatus()
}

async function turnMicOn(): Promise<void> {
  if (!meeting) return
  selfMuted = false
  els.micOffFix.disabled = true
  try {
    await meeting.self.enableAudio()
    lastMediaError = null
  } catch (error) {
    lastMediaError = describe(error)
    console.warn('[call] enableAudio failed', error)
  } finally {
    els.micOffFix.disabled = false
  }
  micMeter.attach(meeting.self.audioTrack ?? null)
  syncSelfControls()
}
els.micOffFix.onclick = () => void turnMicOn()

/** One line each for you and for them, in the settings panel. */
function renderAudioStatus(): void {
  if (!meeting) return
  const mic = meeting.self.getCurrentDevices().audio?.label
  const you = meeting.self.audioEnabled
    ? `on${mic ? ` — ${mic}` : ''}${micMeter.level === 0 && joined ? ' (nothing heard yet — say something)' : ''}`
    : selfMuted
      ? 'muted by you'
      : `OFF — ${lastMediaError ?? 'the browser did not hand over a microphone'}`
  const peer = remoteParticipant
  const them = !joined
    ? 'not connected yet'
    : !peer
      ? 'not in the room yet'
      : peer.audioEnabled === false
        ? 'their microphone is off on their side'
        : !peer.audioTrack
          ? 'on, but no audio has arrived yet'
          : els.remoteAudio.paused
            ? 'arriving, but playback is blocked — use "Tap to hear"'
            : remoteMeter.level === 0
              ? 'arriving and playing (silent right now)'
              : 'arriving and playing'
  els.audioStatus.textContent = `Your mic: ${you}. Them: ${them}.`
}

// ─── Devices ─────────────────────────────────────────────────────────────────

let cameras: RtkDevice[] = []
let microphones: RtkDevice[] = []
let speakers: MediaDeviceInfo[] = []

/** Chrome, Edge and Firefox let a page pick the output device; Safari does not. */
const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/**
 * Fills every device picker — the preview screen's and the in-call panel's —
 * from the same lists, so switching in either place does the same thing.
 * Re-run when the browser reports a device change (a headset plugged in).
 */
async function refreshDevices(): Promise<void> {
  if (!meeting) return
  try {
    ;[cameras, microphones] = await Promise.all([meeting.self.getVideoDevices(), meeting.self.getAudioDevices()])
    const current = meeting.self.getCurrentDevices()

    for (const select of [els.cameraSelect, els.callCam]) fillSelect(select, cameras, current.video?.deviceId)
    for (const select of [els.micSelect, els.callMic]) fillSelect(select, microphones, current.audio?.deviceId)
    els.devices.classList.remove('hidden')

    if (canPickSpeaker) {
      speakers = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
      const chosen = (els.remoteAudio as HTMLMediaElement & { sinkId?: string }).sinkId || 'default'
      fillSelect(
        els.callSpeaker,
        speakers.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind })),
        speakers.some((d) => d.deviceId === chosen) ? chosen : speakers[0]?.deviceId
      )
      els.speakerWrap.classList.toggle('hidden', speakers.length === 0)
    }
  } catch {
    // Device labels are unavailable until permission is granted in some browsers.
    // Not being able to choose is a small loss; failing the call is not.
  }
}

/** Starts from what this browser used last time, when those devices are still here. */
async function applyRememberedDevices(): Promise<void> {
  if (!meeting) return
  const prefs = loadPrefs()
  const current = meeting.self.getCurrentDevices()
  const mic = pickRemembered(microphones, prefs.audioinput)
  if (mic && mic.deviceId !== current.audio?.deviceId) await switchDevice(microphones, mic.deviceId, false)
  const cam = pickRemembered(cameras, prefs.videoinput)
  if (cam && cam.deviceId !== current.video?.deviceId) await switchDevice(cameras, cam.deviceId, false)
  if (canPickSpeaker) {
    const speaker = pickRemembered(speakers, prefs.audiooutput)
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

async function switchDevice(devices: RtkDevice[], deviceId: string, remember = true): Promise<void> {
  const device = devices.find((candidate) => candidate.deviceId === deviceId)
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

async function switchSpeaker(deviceId: string, remember = true): Promise<void> {
  const sinkable = [els.remoteAudio, els.shareAudio] as Array<HTMLMediaElement & { setSinkId?(id: string): Promise<void> }>
  try {
    await Promise.all(sinkable.map((element) => element.setSinkId?.(deviceId)))
    els.settingsHint.textContent = ''
    els.callSpeaker.value = deviceId
    const chosen = speakers.find((d) => d.deviceId === deviceId)
    if (remember && chosen) savePrefs({ audiooutput: { id: chosen.deviceId, label: chosen.label } })
  } catch (error) {
    els.settingsHint.textContent = `Could not switch speaker: ${describe(error)}`
  }
}

els.cameraSelect.onchange = () => void switchDevice(cameras, els.cameraSelect.value)
els.micSelect.onchange = () => void switchDevice(microphones, els.micSelect.value)
els.callCam.onchange = () => void switchDevice(cameras, els.callCam.value)
els.callMic.onchange = () => void switchDevice(microphones, els.callMic.value)
els.callSpeaker.onchange = () => void switchSpeaker(els.callSpeaker.value)
els.callSpeakerTest.onclick = async () => {
  // Rings the chosen output, on top of the call, so the answer is "that one".
  els.callSpeakerTest.disabled = true
  els.callSpeakerTest.textContent = 'Playing…'
  const result = await playTestTone(els.callSpeaker.value)
  els.callSpeakerTest.textContent = result === 'played' ? 'Test again' : 'Could not play'
  els.callSpeakerTest.disabled = false
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices())

for (const box of [els.autoJoin, els.autoJoinCall]) {
  box.onchange = () => {
    savePrefs({ autoJoin: box.checked })
    els.autoJoin.checked = box.checked
    els.autoJoinCall.checked = box.checked
  }
}

function toggleSettings(open?: boolean): void {
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
els.settingsButton.onclick = () => toggleSettings()
els.settingsClose.onclick = () => toggleSettings(false)

// ─── The call ────────────────────────────────────────────────────────────────

async function join(): Promise<void> {
  if (!meeting || joined) return
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
  joined = true

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

  reported = true
  notifyParent('media-joined')

  // Belt and braces for audio. Events tell us when tracks change, but the
  // SDK can hand over a participant before its track exists, or swap a track
  // without an event we listen for. Once a second, make what is playing match
  // what the SDK currently holds; every step is idempotent.
  reconciler = setInterval(reconcileAudio, 1000)

  meeting.self.on('roomLeft', () => void finish('left'))
}

function reconcileAudio(): void {
  if (!meeting) return
  micMeter.attach(meeting.self.audioEnabled ? (meeting.self.audioTrack ?? null) : null)
  const peer = remoteParticipant
  if (peer) {
    const track = peer.audioEnabled === false ? null : (peer.audioTrack ?? null)
    playRemoteAudio(track)
    remoteMeter.attach(track)
    labelPeer(peer)
  }
  // Cheap, and the buttons must never drift from the SDK again.
  const audioOn = meeting.self.audioEnabled
  if (els.mic.classList.contains('off') === audioOn) syncSelfControls()
  else renderAudioStatus()
}

function labelPeer(participant: RtkParticipant): void {
  const name = participant.name || boot.peerName || 'Connected'
  const muted = participant.audioEnabled === false
  els.peerName.textContent = muted ? `${name} · mic off` : name
  els.remoteLevelLabel.textContent = muted ? `${name} (mic off)` : `${name} — what is arriving`
}

function wireParticipants(): void {
  if (!meeting) return
  const attach = (participant: RtkParticipant) => {
    remoteParticipant = participant
    participant.registerVideoElement(els.remote)
    // Video is attached by the SDK helper above. Audio is not — the SDK only
    // hands over the track. Without this line the call is silent.
    playRemoteAudio(participant.audioEnabled === false ? null : (participant.audioTrack ?? null))
    labelPeer(participant)
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
    if (participant.id === remoteParticipant?.id) participant.registerVideoElement(els.remote)
  })
  // Fires when the other side mutes, unmutes, or their track is (re)negotiated —
  // each of those can hand us a different MediaStreamTrack object.
  meeting.participants.joined.on('audioUpdate', (participant) => {
    if (participant.id !== remoteParticipant?.id) return
    remoteParticipant = participant
    reconcileAudio()
  })
  meeting.participants.joined.on('participantLeft', (participant) => {
    if (participant.id !== remoteParticipant?.id) return
    remoteParticipant = null
    playRemoteAudio(null)
    remoteMeter.detach()
    showRemoteShare(null)
    // Not the end of the call: the server's reconnect window decides that. A
    // dropped connection on a train should not hang up on someone.
    showWaitingForPeer(true)
    renderAudioStatus()
  })

  // The other side's screen. A screen track is a plain MediaStreamTrack, so it
  // goes on its own <video> rather than through registerVideoElement.
  const syncShare = (participant: RtkParticipant) => {
    if (participant.id !== remoteParticipant?.id) return
    const on = participant.screenShareEnabled
    showRemoteShare(
      on ? (participant.screenShareTracks?.video ?? null) : null,
      on ? (participant.screenShareTracks?.audio ?? null) : null
    )
  }
  meeting.participants.joined.on('screenShareUpdate', syncShare)
  if (existing[0]) syncShare(existing[0])
}

function showRemoteShare(track: MediaStreamTrack | null, audio: MediaStreamTrack | null = null): void {
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

/**
 * Plays the other side's microphone.
 *
 * A MediaStreamTrack makes no sound on its own; it has to be wrapped in a
 * MediaStream and handed to an element. The same track object is reused when
 * nothing changed, so a mute/unmute does not restart playback.
 */
function playRemoteAudio(track: MediaStreamTrack | null): void {
  playInto(els.remoteAudio, track)
}

const attached = new WeakMap<HTMLMediaElement, MediaStreamTrack | null>()

function playInto(element: HTMLMediaElement, track: MediaStreamTrack | null): void {
  if (attached.get(element) === track) return
  attached.set(element, track)
  if (!track) {
    element.srcObject = null
    return
  }
  element.srcObject = new MediaStream([track])
  console.info(`[call] playing ${element.id}`, track.label || track.id)
  element.play().catch(() => {
    // Refused: the browser wants a gesture on THIS document first. The Join
    // click normally provides one, but not after a reload straight into a live
    // call. One tap fixes it, so offer exactly that.
    els.hear.classList.remove('hidden')
    renderAudioStatus()
  })
}

els.hear.onclick = () => {
  els.hear.classList.add('hidden')
  resumeAudio()
  for (const element of [els.remoteAudio, els.shareAudio]) {
    if (element.srcObject) void element.play().catch(() => els.hear.classList.remove('hidden'))
  }
  renderAudioStatus()
}

function syncShareButton(): void {
  const on = Boolean(meeting?.self.screenShareEnabled)
  els.shareButton.classList.toggle('on', on)
  els.shareButton.setAttribute('aria-pressed', String(on))
  els.shareButton.setAttribute('aria-label', on ? 'Stop sharing your screen' : 'Share your screen')
  els.sharePill.classList.toggle('hidden', !on)
}

function showWaitingForPeer(waiting: boolean): void {
  if (!waiting) {
    els.overlay.classList.add('hidden')
    return
  }
  els.overlay.classList.remove('hidden')
  els.overlay.classList.remove('setup')
  clearError()
  els.preview.classList.add('hidden')
  els.devices.classList.add('hidden')
  els.autoJoinWrap.classList.add('hidden')
  els.join.classList.add('hidden')
  showOverlay(
    boot.who === 'host' ? 'Waiting for them to join…' : `Waiting for ${boot.peerName || 'the host'}…`,
    'Hold on — reconnecting takes a few seconds.'
  )
}

function wireControls(): void {
  els.mic.onclick = async () => {
    if (!meeting) return
    try {
      if (meeting.self.audioEnabled) {
        selfMuted = true
        await meeting.self.disableAudio()
      } else {
        selfMuted = false
        await meeting.self.enableAudio()
        lastMediaError = null
      }
    } catch (error) {
      lastMediaError = describe(error)
    }
    micMeter.attach(meeting.self.audioEnabled ? (meeting.self.audioTrack ?? null) : null)
    syncSelfControls()
  }

  els.cam.onclick = async () => {
    if (!meeting) return
    try {
      if (meeting.self.videoEnabled) await meeting.self.disableVideo()
      else await meeting.self.enableVideo()
    } catch (error) {
      els.settingsHint.textContent = `Camera: ${describe(error)}`
    }
    syncSelfControls()
  }

  // Screen share exists only where the browser can capture a screen — no
  // mobile browser can, so the button is simply absent there rather than
  // present and broken.
  if (navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices) {
    els.shareButton.classList.remove('hidden')
    els.shareButton.onclick = async () => {
      if (!meeting) return
      try {
        if (meeting.self.screenShareEnabled) await meeting.self.disableScreenShare()
        else await meeting.self.enableScreenShare()
      } catch (error) {
        // Cancelling the browser's picker rejects too; that is not an error
        // worth showing.
        const name = (error as { name?: string } | null)?.name ?? ''
        if (name !== 'NotAllowedError' && name !== 'AbortError') showError(describe(error))
      }
      syncShareButton()
    }
    // The browser's own "Stop sharing" bar ends a share behind our back.
    meeting?.self.on('screenShareUpdate', () => syncShareButton())
  }

  els.leave.onclick = () => void finish('ended')
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
async function finish(type: 'ended' | 'left'): Promise<void> {
  if (finishing) return
  finishing = true

  if (ticker) clearInterval(ticker)
  ticker = null
  if (reconciler) clearInterval(reconciler)
  reconciler = null
  els.controls.hidden = true
  els.timer.classList.add('hidden')
  els.micOff.classList.add('hidden')
  toggleSettings(false)

  if (reported) notifyParent('media-left')
  if (type === 'ended') notifyParent('ended')

  micMeter.detach()
  remoteMeter.detach()
  playRemoteAudio(null)
  showRemoteShare(null)

  clearError()
  els.overlay.classList.remove('setup')
  els.preview.classList.add('hidden')
  els.devices.classList.add('hidden')
  els.autoJoinWrap.classList.add('hidden')
  els.join.classList.add('hidden')
  showOverlay('Call ended', 'Thanks for the conversation.')

  await Promise.race([
    (meeting?.leave() ?? Promise.resolve()).catch(() => {
      /* already gone */
    }),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// A tab closed mid-call should tell the server immediately rather than waiting
// out the reconnect window while the other person stares at a frozen frame.
window.addEventListener('pagehide', () => {
  if (reported && !finishing) notifyParent('media-left')
})

els.retry.onclick = () => void setup()
els.abandon.onclick = () => void finish('ended')

void setup()

export {}

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
 *   3. Show the preview and device pickers. Still not in the room.
 *   4. `meeting.join()` on an explicit second click.
 *
 * Asking for permissions any earlier — on page load, or when someone joins the
 * queue — produces denials, and a denial in Chrome is remembered for the origin.
 * One badly-timed prompt costs every future call from that browser.
 */

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
  controls: $<HTMLDivElement>('controls'),
  mic: $<HTMLButtonElement>('btn-mic'),
  cam: $<HTMLButtonElement>('btn-cam'),
  shareButton: $<HTMLButtonElement>('btn-share'),
  leave: $<HTMLButtonElement>('btn-leave')
}

let meeting: RtkMeeting | null = null
let remoteParticipant: RtkParticipant | null = null
let startedAt = 0
let ticker: ReturnType<typeof setInterval> | null = null
let reported = false

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

  showOverlay('Camera and microphone', 'Check yourself over before you join.')
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

  els.preview.classList.remove('hidden')
  // `true` marks this as a local preview that is not published to the room.
  meeting.self.registerVideoElement(els.preview, true)
  await populateDevices()

  els.join.classList.remove('hidden')
  els.join.textContent = boot.who === 'host' ? 'Join the call' : `Join ${boot.peerName || credentials.displayName}`
  els.join.onclick = () => void join()
  els.join.focus()
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

async function populateDevices(): Promise<void> {
  if (!meeting) return
  try {
    const [cameras, microphones] = await Promise.all([
      meeting.self.getVideoDevices(),
      meeting.self.getAudioDevices()
    ])
    const current = meeting.self.getCurrentDevices()

    fillSelect(els.cameraSelect, cameras, current.video?.deviceId)
    fillSelect(els.micSelect, microphones, current.audio?.deviceId)
    els.devices.classList.remove('hidden')

    els.cameraSelect.onchange = () => void switchDevice(cameras, els.cameraSelect.value)
    els.micSelect.onchange = () => void switchDevice(microphones, els.micSelect.value)
  } catch {
    // Device labels are unavailable until permission is granted in some browsers.
    // Not being able to choose is a small loss; failing the call is not.
  }
}

function fillSelect(select: HTMLSelectElement, devices: RtkDevice[], selected?: string): void {
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label || `Device ${index + 1}`
      if (device.deviceId === selected) option.selected = true
      return option
    })
  )
}

async function switchDevice(devices: RtkDevice[], deviceId: string): Promise<void> {
  const device = devices.find((candidate) => candidate.deviceId === deviceId)
  if (device && meeting) await meeting.self.setDevice(device)
}

// ─── The call ────────────────────────────────────────────────────────────────

async function join(): Promise<void> {
  if (!meeting) return
  els.join.disabled = true
  els.join.textContent = 'Connecting…'
  showOverlay('Connecting…', 'One moment.')

  try {
    await meeting.join()
  } catch (error) {
    els.join.disabled = false
    handleMediaError(error)
    return
  }

  meeting.self.deregisterVideoElement(els.preview)
  els.preview.classList.add('hidden')
  els.local.classList.remove('hidden')
  meeting.self.registerVideoElement(els.local, true)

  els.overlay.classList.add('hidden')
  els.controls.hidden = false
  els.timer.classList.remove('hidden')

  startedAt = Date.now()
  ticker = setInterval(updateTimer, 1000)
  updateTimer()

  wireParticipants()
  wireControls()

  reported = true
  notifyParent('media-joined')

  meeting.self.on('roomLeft', () => finish('left'))
}

function wireParticipants(): void {
  if (!meeting) return
  const attach = (participant: RtkParticipant) => {
    remoteParticipant = participant
    participant.registerVideoElement(els.remote)
    // Video is attached by the SDK helper above. Audio is not — the SDK only
    // hands over the track. Without this line the call is silent.
    playRemoteAudio(participant.audioEnabled === false ? null : (participant.audioTrack ?? null))
    els.peerName.textContent = participant.name || boot.peerName || 'Connected'
    els.peerName.classList.remove('hidden')
    showWaitingForPeer(false)
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
    playRemoteAudio(participant.audioEnabled ? (participant.audioTrack ?? null) : null)
  })
  meeting.participants.joined.on('participantLeft', (participant) => {
    if (participant.id !== remoteParticipant?.id) return
    remoteParticipant = null
    playRemoteAudio(null)
    showRemoteShare(null)
    // Not the end of the call: the server's reconnect window decides that. A
    // dropped connection on a train should not hang up on someone.
    showWaitingForPeer(true)
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
  element.play().catch(() => {
    // Refused: the browser wants a gesture on THIS document first. The Join
    // click normally provides one, but not after a reload straight into a live
    // call. One tap fixes it, so offer exactly that.
    els.hear.classList.remove('hidden')
  })
}

els.hear.onclick = () => {
  els.hear.classList.add('hidden')
  for (const element of [els.remoteAudio, els.shareAudio]) {
    if (element.srcObject) void element.play().catch(() => els.hear.classList.remove('hidden'))
  }
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
  clearError()
  els.preview.classList.add('hidden')
  els.devices.classList.add('hidden')
  els.join.classList.add('hidden')
  showOverlay(
    boot.who === 'host' ? 'Waiting for them to join…' : `Waiting for ${boot.peerName || 'the host'}…`,
    'Hold on — reconnecting takes a few seconds.'
  )
}

function wireControls(): void {
  els.mic.onclick = async () => {
    if (!meeting) return
    const enabled = meeting.self.audioEnabled
    if (enabled) await meeting.self.disableAudio()
    else await meeting.self.enableAudio()
    els.mic.classList.toggle('off', enabled)
    els.mic.setAttribute('aria-pressed', String(enabled))
    els.mic.setAttribute('aria-label', enabled ? 'Unmute microphone' : 'Mute microphone')
  }

  els.cam.onclick = async () => {
    if (!meeting) return
    const enabled = meeting.self.videoEnabled
    if (enabled) await meeting.self.disableVideo()
    else await meeting.self.enableVideo()
    els.cam.classList.toggle('off', enabled)
    els.cam.setAttribute('aria-pressed', String(enabled))
    els.cam.setAttribute('aria-label', enabled ? 'Turn camera on' : 'Turn camera off')
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

async function finish(type: 'ended' | 'left'): Promise<void> {
  if (ticker) clearInterval(ticker)
  ticker = null
  els.controls.hidden = true
  els.timer.classList.add('hidden')

  try {
    await meeting?.leave()
  } catch {
    /* already gone */
  }
  if (reported) notifyParent('media-left')
  notifyParent(type === 'ended' ? 'ended' : 'media-left')

  clearError()
  els.preview.classList.add('hidden')
  els.devices.classList.add('hidden')
  els.join.classList.add('hidden')
  showOverlay('Call ended', 'Thanks for the conversation.')
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// A tab closed mid-call should tell the server immediately rather than waiting
// out the reconnect window while the other person stares at a frozen frame.
window.addEventListener('pagehide', () => {
  if (reported) notifyParent('media-left')
})

els.retry.onclick = () => void setup()
els.abandon.onclick = () => void finish('ended')

void setup()

export {}

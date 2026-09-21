/**
 * The dashboard's camera surface: a device check, and an in-browser recorder for
 * the intro clip.
 *
 * Both are the same screen with a different footer, because they are the same
 * question — "is my camera pointing at me, is my mic picking me up, does the
 * light look right" — asked either before going live or before recording.
 *
 * Recording here rather than uploading a file matters more than it sounds: the
 * clip is meant to be refreshed often ("here's what I'm working on today"), and a
 * loop that requires opening a camera app, trimming, exporting and uploading is a
 * loop that gets recorded once and then goes stale. Stale is worse than none,
 * because the whole promise is that the person is actually there.
 *
 * The camera is opened only when this surface is opened, and every track is
 * stopped when it closes — a dashboard left open all day must not sit there with
 * the camera light on.
 */

export type MediaMode = 'check' | 'record'

/** Max clip length. The spec calls for 5–15s; 20 is the hard stop. */
const MAX_SECONDS = 20
const WARN_SECONDS = 15

/**
 * Preference order for the recording container.
 *
 * MP4/H.264 first and deliberately: iPhone Safari cannot play VP8/VP9 WebM, and
 * the widget's clip has to work on the device most visitors are holding. Chrome
 * and Safari both offer MP4 recording now; WebM is the fallback for browsers that
 * do not, and when it happens the UI says so rather than shipping a clip that is
 * silently blank on iOS.
 */
const CONTAINERS = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

function pickContainer(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  return CONTAINERS.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

interface Els {
  modal: HTMLDivElement
  title: HTMLElement
  hint: HTMLElement
  preview: HTMLVideoElement
  playback: HTMLVideoElement
  level: HTMLElement
  levelBar: HTMLElement
  cameraSelect: HTMLSelectElement
  micSelect: HTMLSelectElement
  error: HTMLElement
  timer: HTMLElement
  record: HTMLButtonElement
  stop: HTMLButtonElement
  retake: HTMLButtonElement
  use: HTMLButtonElement
  close: HTMLButtonElement
  sound: HTMLButtonElement
}

export interface MediaSurfaceOptions {
  /** Uploads a recorded clip (and its poster frame). Resolves on success. */
  upload: (clip: Blob, clipType: string, poster: Blob | null) => Promise<void>
  onStatus: (message: string, isError?: boolean) => void
}

import { loadPrefs, pickRemembered, savePrefs } from '../shared/prefs'

export class MediaSurface {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private recorded: { blob: Blob; type: string; poster: Blob | null } | null = null
  private audioCtx: AudioContext | null = null
  private levelFrame: number | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private mode: MediaMode = 'check'
  private objectUrl: string | null = null
  /** Whether the recorded stream carried a microphone track at all. */
  private hadAudio = false
  private lastFocused: HTMLElement | null = null

  constructor(
    private readonly els: Els,
    private readonly options: MediaSurfaceOptions
  ) {
    els.close.onclick = () => this.close()
    els.record.onclick = () => void this.startRecording()
    els.stop.onclick = () => this.stopRecording()
    els.retake.onclick = () => void this.retake()
    els.use.onclick = () => void this.useRecording()
    els.sound.onclick = () => this.toggleSound()
    els.cameraSelect.onchange = () => void this.restart()
    els.micSelect.onchange = () => void this.restart()
    els.modal.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') this.close()
    })
  }

  async open(mode: MediaMode): Promise<void> {
    this.mode = mode
    this.lastFocused = document.activeElement as HTMLElement | null
    this.els.modal.classList.remove('hidden')
    this.els.title.textContent = mode === 'record' ? 'Record your intro clip' : 'Camera and microphone'
    this.els.hint.textContent =
      mode === 'record'
        ? `Aim for 5–15 seconds. It loops silently in the widget, so lead with your face, not a sentence that needs sound.`
        : 'Check your framing, your light and your levels before you go live. The camera and microphone you pick here are used for every call on this browser.'
    this.setError('')
    this.showRecorded(false)
    this.els.record.classList.toggle('hidden', mode !== 'record')
    await this.start()
  }

  close(): void {
    this.releaseStream()
    this.els.modal.classList.add('hidden')
    this.lastFocused?.focus?.()
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setError('This browser cannot open a camera. Try Chrome, Edge or Safari.')
      return
    }
    // Before any pick, start from the browser's remembered devices (the same
    // ones the call page uses), if they are still plugged in.
    let wanted = { camera: this.els.cameraSelect.value, mic: this.els.micSelect.value }
    if (!wanted.camera && !wanted.mic) {
      try {
        const known = await navigator.mediaDevices.enumerateDevices()
        const prefs = loadPrefs()
        wanted = {
          camera: pickRemembered(known.filter((d) => d.kind === 'videoinput'), prefs.videoinput)?.deviceId ?? '',
          mic: pickRemembered(known.filter((d) => d.kind === 'audioinput'), prefs.audioinput)?.deviceId ?? ''
        }
      } catch {
        /* the browser default it is */
      }
    }
    const constraints = (exact: boolean): MediaStreamConstraints => ({
      video: {
        deviceId: exact && wanted.camera ? { exact: wanted.camera } : undefined,
        // A native camera mode, deliberately. 1280x800 is not one, so cameras
        // satisfy it by scaling — which delivers frames at uneven intervals and
        // is how audio and video end up drifting apart over a 12-second clip.
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: { deviceId: exact && wanted.mic ? { exact: wanted.mic } : undefined }
    })
    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints(true))
      } catch (error) {
        // A remembered device that is gone (or an id the browser rotated) must
        // not block the check; fall back to whatever the browser offers.
        const name = (error as { name?: string } | null)?.name ?? ''
        if ((name === 'OverconstrainedError' || name === 'NotFoundError') && (wanted.camera || wanted.mic)) {
          this.stream = await navigator.mediaDevices.getUserMedia(constraints(false))
        } else throw error
      }
    } catch (error) {
      this.setError(describePermission(error))
      return
    }

    this.els.preview.srcObject = this.stream
    // Muted, or the dashboard feeds its own microphone back through its speakers.
    this.els.preview.muted = true
    void this.els.preview.play().catch(() => {})

    await this.listDevices()
    this.startLevelMeter()
    this.els.record.focus()
  }

  /**
   * Labels are only populated after permission has been granted, which is why
   * this runs after getUserMedia rather than before.
   */
  private async listDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const current = {
        video: this.stream?.getVideoTracks()[0]?.getSettings().deviceId,
        audio: this.stream?.getAudioTracks()[0]?.getSettings().deviceId
      }
      fill(this.els.cameraSelect, devices.filter((d) => d.kind === 'videoinput'), current.video)
      fill(this.els.micSelect, devices.filter((d) => d.kind === 'audioinput'), current.audio)
    } catch {
      /* the pickers stay empty; the default device still works */
    }
  }

  private async restart(): Promise<void> {
    // A pick here is a pick for every call on this browser.
    const chosen = (select: HTMLSelectElement) => {
      const option = select.selectedOptions[0]
      return option && select.value ? { id: select.value, label: option.textContent ?? '' } : undefined
    }
    savePrefs({ videoinput: chosen(this.els.cameraSelect), audioinput: chosen(this.els.micSelect) })
    this.releaseStream(false)
    await this.start()
  }

  private releaseStream(closeAudio = true): void {
    if (this.levelFrame !== null) cancelAnimationFrame(this.levelFrame)
    this.levelFrame = null
    if (closeAudio && this.audioCtx) {
      void this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        /* already stopping */
      }
    }
    this.recorder = null
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    // Stopping every track is what actually turns the camera light off. Dropping
    // the reference alone does not.
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.els.preview.srcObject = null
  }

  /**
   * A live level meter, because "can you hear me?" is the single most common way
   * a call starts badly, and it is answerable before the call instead of during.
   */
  private startLevelMeter(): void {
    const track = this.stream?.getAudioTracks()[0]
    if (!track) return
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.audioCtx ??= new Ctor()
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]))
      const analyser = this.audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)

      const draw = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) {
          const centred = (value - 128) / 128
          sum += centred * centred
        }
        const rms = Math.sqrt(sum / data.length)
        // Compressed so normal speech fills most of the bar rather than a sliver.
        const level = Math.min(100, Math.round(Math.sqrt(rms) * 190))
        this.els.levelBar.style.width = `${level}%`
        this.els.level.classList.toggle('quiet', level < 4)
        this.levelFrame = requestAnimationFrame(draw)
      }
      draw()
    } catch {
      /* the meter is a nicety */
    }
  }

  // ── Recording ────────────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (!this.stream) return
    const container = pickContainer()
    if (!container) {
      this.setError('This browser cannot record video. Upload a file instead, or try Chrome or Safari.')
      return
    }

    this.chunks = []
    // A stream with no audio track records silently and looks identical until
    // playback. Noticing it here is the difference between one retake and
    // shipping a clip that is mute for everyone.
    this.hadAudio = this.stream.getAudioTracks().length > 0
    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: container,
        // Sized for where this actually plays: a panel about 352px wide, at most
        // ~700px on a high-density screen. 2.5 Mbps made a 4.2 MB file for twelve
        // seconds, which every visitor who opens the widget then downloads.
        videoBitsPerSecond: 1_000_000,
        audioBitsPerSecond: 96_000
      })
    } catch (error) {
      this.setError(`Could not start recording: ${describe(error)}`)
      return
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onstop = () => void this.finishRecording(container)

    // A timeslice makes the recorder flush on a fixed cadence, so audio and video
    // are interleaved as they arrive rather than buffered independently and
    // stitched at the end.
    this.recorder.start(250)
    this.startedAt = Date.now()
    this.els.record.classList.add('hidden')
    this.els.stop.classList.remove('hidden')
    this.els.timer.classList.remove('hidden')
    this.els.modal.classList.add('recording')

    this.tick = setInterval(() => {
      const seconds = (Date.now() - this.startedAt) / 1000
      this.els.timer.textContent = `${seconds.toFixed(1)}s`
      this.els.timer.classList.toggle('over', seconds > WARN_SECONDS)
      // A hard stop, so a forgotten recording cannot become a 40MB upload.
      if (seconds >= MAX_SECONDS) this.stopRecording()
    }, 100)
    this.els.stop.focus()
  }

  private stopRecording(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    if (this.recorder?.state === 'recording') this.recorder.stop()
  }

  private async finishRecording(container: string): Promise<void> {
    this.els.modal.classList.remove('recording')
    this.els.stop.classList.add('hidden')
    this.els.timer.classList.add('hidden')

    const type = container.split(';')[0] ?? 'video/webm'
    const blob = new Blob(this.chunks, { type })
    if (blob.size === 0) {
      this.setError('Nothing was recorded. Try again.')
      this.els.record.classList.remove('hidden')
      return
    }

    // A still frame from the live preview, uploaded alongside as the poster. It
    // is what the widget shows when autoplay is refused (data saver, low power
    // mode) and when the container will not play — so the visitor sees a face
    // rather than a black rectangle.
    const poster = await this.capturePoster()
    this.recorded = { blob, type, poster }

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = URL.createObjectURL(blob)
    this.els.playback.src = this.objectUrl
    // NOT the native `loop`. A recorded file's audio and video tracks rarely end
    // on the same millisecond, and letting the browser wrap around restarts them
    // from different points — the drift then compounds on every pass, which is
    // what "the audio is out of sync" actually looks like after a minute.
    // Seeking explicitly to zero resets both tracks together.
    this.els.playback.loop = false
    this.els.playback.onended = () => {
      this.els.playback.currentTime = 0
      void this.els.playback.play().catch(() => {})
    }
    this.showRecorded(true)

    // Play it back WITH sound. Autoplay policy allows this because stopping the
    // recording was itself a user gesture — but if a browser refuses anyway, fall
    // back to muted rather than showing a frozen frame, and say so on the button.
    this.els.playback.muted = false
    try {
      await this.els.playback.play()
    } catch {
      this.els.playback.muted = true
      void this.els.playback.play().catch(() => {})
    }
    this.syncSoundButton()

    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    const isWebm = type.includes('webm')
    const notes = [`Recorded ${seconds}s${isWebm ? ' as WebM' : ''}.`]
    if (!this.hadAudio) {
      notes.push('No microphone was captured — check the mic picker and record again.')
    }
    if (isWebm) {
      notes.push('iPhone Safari cannot play WebM, so those visitors see the still frame instead. Record in Safari for MP4 if that matters.')
    }
    notes.push('In the widget it autoplays muted with an unmute button, because browsers refuse to autoplay sound.')
    this.options.onStatus(notes.join(' '), isWebm || !this.hadAudio)
    this.els.use.focus()
  }

  private async capturePoster(): Promise<Blob | null> {
    try {
      const video = this.els.preview
      if (!video.videoWidth) return null
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85))
    } catch {
      return null
    }
  }

  private async retake(): Promise<void> {
    this.recorded = null
    this.showRecorded(false)
    this.els.record.classList.remove('hidden')
    this.setError('')
    this.els.record.focus()
  }

  private async useRecording(): Promise<void> {
    if (!this.recorded) return
    this.els.use.disabled = true
    this.els.use.textContent = 'Uploading…'
    try {
      await this.options.upload(this.recorded.blob, this.recorded.type, this.recorded.poster)
      this.close()
    } catch (error) {
      this.setError(describe(error))
    } finally {
      this.els.use.disabled = false
      this.els.use.textContent = 'Use this clip'
    }
  }

  private toggleSound(): void {
    this.els.playback.muted = !this.els.playback.muted
    if (!this.els.playback.muted) void this.els.playback.play().catch(() => {})
    this.syncSoundButton()
  }

  private syncSoundButton(): void {
    const muted = this.els.playback.muted
    this.els.sound.textContent = muted ? 'Sound off' : 'Sound on'
    this.els.sound.classList.toggle('off', muted)
    this.els.sound.setAttribute('aria-pressed', String(!muted))
  }

  private showRecorded(show: boolean): void {
    this.els.sound.classList.toggle('hidden', !show)
    this.els.playback.classList.toggle('hidden', !show)
    this.els.preview.classList.toggle('hidden', show)
    this.els.retake.classList.toggle('hidden', !show)
    this.els.use.classList.toggle('hidden', !show)
    if (show) this.els.record.classList.add('hidden')
  }

  private setError(message: string): void {
    this.els.error.textContent = message
    this.els.error.classList.toggle('hidden', !message)
  }
}

function fill(select: HTMLSelectElement, devices: MediaDeviceInfo[], selected?: string): void {
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Turns a DOMException into something that tells you what to actually do. */
function describePermission(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError') {
    return 'Camera access was blocked. Allow it from the icon in your address bar, then try again.'
  }
  if (name === 'NotFoundError') return 'No camera or microphone was found on this machine.'
  if (name === 'NotReadableError') return 'Your camera is in use by another app. Close it and try again.'
  return `Could not open the camera: ${describe(error)}`
}

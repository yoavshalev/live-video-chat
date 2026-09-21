/** The Clip tab and the camera surface: recording, uploading and previewing the intro loop. */

import { MediaSurface } from './media'
import { $, describe, els, toast } from './dom'
import { showTab } from './tabs'

const media = new MediaSurface(
  {
    modal: $<HTMLDivElement>('media-modal'),
    title: $<HTMLElement>('media-title'),
    hint: $<HTMLElement>('media-hint'),
    preview: $<HTMLVideoElement>('media-preview'),
    playback: $<HTMLVideoElement>('media-playback'),
    level: $<HTMLElement>('media-level'),
    levelBar: $<HTMLElement>('media-level-bar'),
    cameraSelect: $<HTMLSelectElement>('media-camera'),
    micSelect: $<HTMLSelectElement>('media-mic'),
    speakerWrap: $<HTMLElement>('media-speaker-wrap'),
    speakerSelect: $<HTMLSelectElement>('media-speaker'),
    speakerTest: $<HTMLButtonElement>('media-speaker-test'),
    error: $<HTMLElement>('media-error'),
    timer: $<HTMLElement>('media-timer'),
    record: $<HTMLButtonElement>('media-record'),
    stop: $<HTMLButtonElement>('media-stop'),
    retake: $<HTMLButtonElement>('media-retake'),
    use: $<HTMLButtonElement>('media-use'),
    close: $<HTMLButtonElement>('media-close'),
    sound: $<HTMLButtonElement>('media-sound')
  },
  {
    upload: async (clip, clipType, poster) => {
      await uploadMedia('loop', clip, clipType.includes('mp4') ? 'loop.mp4' : 'loop.webm')
      if (poster) {
        try {
          await uploadMedia('poster', poster, 'poster.jpg')
        } catch {
          /* the clip is already live */
        }
      }
      toast('Intro clip updated. Widgets pick it up immediately.')
    },
    onStatus: (message, isError) => {
      els.loopStatus.textContent = message
      els.loopStatus.style.color = isError ? 'var(--busy)' : ''
    }
  }
)

async function uploadMedia(kind: 'loop' | 'poster', blob: Blob, filename: string): Promise<void> {
  const body = new FormData()
  body.append('file', blob, filename)
  const response = await fetch(`/host/media/${kind}`, { method: 'POST', body })
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; url?: string }
  if (!response.ok || !result.ok) throw new Error(result.error ?? `upload failed (${response.status})`)
  if (kind === 'loop' && result.url) {
    els.loopPreview.src = result.url
    els.loopWrap.classList.remove('hidden')
    document.getElementById('loop-empty')?.classList.add('hidden')
    void els.loopPreview.play().catch(() => {})
    showTab('clip')
    els.loopWrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
    els.loopWrap.classList.remove('landed')
    void els.loopWrap.offsetWidth
    els.loopWrap.classList.add('landed')
  }
}

/**
 * Looping by hand rather than with the `loop` attribute: a recording's audio and
 * video tracks rarely end on the same millisecond, and the native wrap-around
 * restarts them from different points, so the gap compounds every pass.
 */
function loopCleanly(video: HTMLVideoElement): void {
  video.loop = false
  video.onended = () => {
    video.currentTime = 0
    void video.play().catch(() => {})
  }
}

export function wireClip(): void {
  loopCleanly(els.loopPreview)

  els.loopSound.onclick = () => {
    els.loopPreview.muted = !els.loopPreview.muted
    els.loopSound.textContent = els.loopPreview.muted ? 'Sound off' : 'Sound on'
    els.loopSound.classList.toggle('off', els.loopPreview.muted)
    els.loopSound.setAttribute('aria-pressed', String(!els.loopPreview.muted))
    if (!els.loopPreview.muted) void els.loopPreview.play().catch(() => {})
  }

  els.btnRecord.onclick = () => void media.open('record')
  els.btnCheck.onclick = () => void media.open('check')

  els.loopForm.onsubmit = async (event) => {
    event.preventDefault()
    const file = els.loopFile.files?.[0]
    if (!file) {
      els.loopStatus.textContent = 'Choose a file first.'
      return
    }
    els.loopStatus.textContent = 'Uploading…'
    try {
      await uploadMedia('loop', file, file.name)
      els.loopStatus.textContent = 'Uploaded. Every widget picks it up on its next load.'
    } catch (error) {
      els.loopStatus.textContent = describe(error)
    }
  }
}

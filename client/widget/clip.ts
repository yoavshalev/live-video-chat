/**
 * The intro clip.
 *
 * Muted, inline, looping and autoplaying — the only combination browsers allow
 * without a gesture. The pill says "Live now" because the *person* is live; the
 * note underneath says the clip is an intro. Both are needed: the pill without
 * the note reads as a live camera feed, which it is not.
 */

import type { HostProfileView } from '../../src/shared/protocol'
import { COPY } from '../../src/config'
import { ICONS, el, icon, replace } from './dom'

export class ClipView {
  private element: HTMLElement | null = null
  private url: string | null = null
  private muted = true

  reset(): void {
    this.element = null
    this.url = null
  }

  /**
   * Reused unless the clip itself changed. Rebuilding it meant a fresh <video>
   * on every presence update — so a stranger joining the queue re-downloaded
   * and restarted the clip on everyone else's phone.
   */
  render(profile: HostProfileView | null, name: string, avatar: () => HTMLElement): HTMLElement {
    const loop = profile?.loopVideoUrl ?? null
    const poster = profile?.loopPosterUrl
    if (this.element && this.url === loop) return this.element

    const clip = el('div', { class: 'clip' })
    this.element = clip
    this.url = loop

    if (loop) {
      const video = el('video', {
        attrs: {
          src: loop,
          poster: poster ?? undefined,
          autoplay: true,
          muted: true,
          playsinline: true,
          // Metadata only until it is on screen; the clip must not compete with
          // the host page's own loading.
          preload: 'metadata',
          'aria-label': `Intro clip from ${name}`
        }
      }) as HTMLVideoElement
      video.muted = this.muted
      // Some browsers ignore the attribute and honour only the property.
      video.playsInline = true
      // Looped by hand: a recording's audio and video tracks rarely end on the
      // same millisecond, and the native wrap-around restarts them from
      // different points, so the drift compounds on every pass. Seeking to zero
      // puts both tracks back together. Matters here because this clip loops for
      // as long as the panel is open.
      video.loop = false
      video.onended = () => {
        video.currentTime = 0
        void video.play().catch(() => {})
      }
      void video.play().catch(() => {
        // Autoplay refused (data saver, low power mode). The poster remains, which
        // is why one is worth uploading.
      })
      clip.append(video)

      // Toggled in place rather than through a re-render: rebuilding the panel
      // recreates the <video> and restarts the clip from zero, so unmuting would
      // throw away whatever the visitor was in the middle of watching.
      const soundButton = el('button', {
        class: 'clip-sound',
        attrs: { type: 'button', 'aria-label': 'Unmute intro clip', 'aria-pressed': 'false' }
      })
      const syncSound = () => {
        video.muted = this.muted
        replace(soundButton, icon(this.muted ? ICONS.soundOff : ICONS.soundOn, 15))
        soundButton.setAttribute('aria-label', this.muted ? 'Unmute intro clip' : 'Mute intro clip')
        soundButton.setAttribute('aria-pressed', String(!this.muted))
      }
      soundButton.addEventListener('click', () => {
        this.muted = !this.muted
        syncSound()
        if (!this.muted) void video.play().catch(() => {})
      })
      syncSound()
      clip.append(soundButton)
    } else if (poster) {
      clip.append(el('img', { attrs: { src: poster, alt: name, loading: 'lazy', decoding: 'async' } }))
    } else {
      // No clip uploaded yet. A designed empty state, not a broken <video>.
      clip.append(
        el('div', {
          class: 'fallback',
          children: [avatar(), el('span', { text: `${name} is here right now` })]
        })
      )
    }

    clip.append(
      el('span', {
        class: 'clip-pill',
        children: [el('span', { class: 'dot available', attrs: { 'aria-hidden': 'true' } }), COPY.livePill]
      })
    )
    return clip
  }
}

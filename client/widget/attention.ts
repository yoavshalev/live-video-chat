/**
 * "Your turn" has to be noticeable in a background tab without being obnoxious
 * or falling foul of autoplay and notification policy. Three channels, each
 * used only when it is actually permitted: a flashing title, a notification the
 * visitor already allowed, and a chime once they have interacted with the page.
 */

export class Attention {
  /** Audio may only be played after the visitor has interacted with the page. */
  interacted = false
  private titleTimer: ReturnType<typeof setInterval> | null = null
  private originalTitle = ''

  constructor(private readonly nameOf: () => string) {}

  alertVisitor(): void {
    if (document.visibilityState !== 'visible') {
      this.startTitleFlash()
      // Only if the visitor already granted it. Asking at this moment would put
      // a permission prompt between them and the call.
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(`${this.nameOf()} is ready for you`, { body: "It's your turn — join the call.", tag: 'founderlive' })
        } catch {
          /* some browsers require a service worker; the title flash still works */
        }
      }
    }
    if (this.interacted) playChime()
  }

  private startTitleFlash(): void {
    if (this.titleTimer) return
    this.originalTitle = document.title
    let on = false
    this.titleTimer = setInterval(() => {
      on = !on
      document.title = on ? `🔔 Your turn — ${this.nameOf()}` : this.originalTitle
    }, 1200)
  }

  stopTitleFlash(): void {
    if (!this.titleTimer) return
    clearInterval(this.titleTimer)
    this.titleTimer = null
    if (this.originalTitle) document.title = this.originalTitle
  }
}

/** A short, quiet two-tone chime, synthesised so the widget ships no audio asset. */
function playChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55)
    gain.connect(ctx.destination)

    for (const [frequency, at] of [[660, 0], [880, 0.16]] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = frequency
      osc.connect(gain)
      osc.start(ctx.currentTime + at)
      osc.stop(ctx.currentTime + at + 0.3)
    }
    setTimeout(() => void ctx.close().catch(() => {}), 900)
  } catch {
    /* audio is a nicety, never a requirement */
  }
}

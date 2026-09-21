/**
 * A short two-tone chime, synthesised with WebAudio so nothing ships an audio
 * asset.
 *
 * Browsers refuse to start audio until the person has interacted with the page,
 * and they enforce it at the AudioContext: one created before a gesture sits in
 * `suspended` and every `play()` is silently dropped. So the context is created
 * lazily and `unlock()` is called from a real pointer/key event; `unlocked`
 * tells the caller whether sound will actually be heard, so it can fall back
 * to something visible instead of pretending it rang.
 */

export interface Chime {
  /** True once the context is running, i.e. a play() will be audible. */
  readonly unlocked: boolean
  /** Call from a user gesture. Resolves true if audio is now allowed. */
  unlock(): Promise<boolean>
  /** Rings, or does nothing if not unlocked. Never throws. */
  play(): void
}

export function createChime(options: { gain?: number } = {}): Chime {
  const gainLevel = options.gain ?? 0.09
  let ctx: AudioContext | null = null
  const Ctor =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined

  return {
    get unlocked() {
      return ctx !== null && ctx.state === 'running'
    },

    async unlock() {
      if (!Ctor) return false
      try {
        ctx ??= new Ctor()
        if (ctx.state !== 'running') await ctx.resume()
        return ctx.state === 'running'
      } catch {
        return false
      }
    },

    play() {
      if (!ctx || ctx.state !== 'running') return
      try {
        const now = ctx.currentTime
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0.0001, now)
        gain.gain.exponentialRampToValueAtTime(gainLevel, now + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6)
        gain.connect(ctx.destination)

        // A rising fifth — reads as "attention", not "alarm".
        for (const [frequency, at] of [[660, 0], [880, 0.16]] as const) {
          const osc = ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.value = frequency
          osc.connect(gain)
          osc.start(now + at)
          osc.stop(now + at + 0.32)
        }
      } catch {
        /* audio is a nicety, never a requirement */
      }
    }
  }
}

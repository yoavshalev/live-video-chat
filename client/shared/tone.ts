/**
 * "Is this the right speaker?" — a short rising arpeggio played through a
 * chosen output device.
 *
 * Synthesised with WebAudio so nothing ships an audio asset, then routed to an
 * <audio> element rather than the context's destination, because an element
 * is the only thing a page can point at a specific output (`setSinkId`).
 * Chrome, Edge and Firefox support that; Safari plays through the system
 * default and says so.
 *
 * Call from a click: browsers refuse to start audio before a gesture.
 */

export type ToneResult = 'played' | 'default-output' | 'failed'

let element: (HTMLAudioElement & { setSinkId?(id: string): Promise<void> }) | null = null

export async function playTestTone(sinkId?: string): Promise<ToneResult> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return 'failed'
  const ctx = new Ctor()
  try {
    if (ctx.state !== 'running') await ctx.resume()
    const destination = ctx.createMediaStreamDestination()
    const gain = ctx.createGain()
    gain.connect(destination)

    // Three notes of a major triad, each a touch louder: unmistakably a test
    // tone, and long enough to walk over to the other speaker.
    const now = ctx.currentTime
    for (const [frequency, at] of [[523.25, 0], [659.25, 0.28], [783.99, 0.56]] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = frequency
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, now + at)
      env.gain.exponentialRampToValueAtTime(0.18, now + at + 0.03)
      env.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.5)
      osc.connect(env)
      env.connect(gain)
      osc.start(now + at)
      osc.stop(now + at + 0.55)
    }

    element ??= document.createElement('audio')
    element.srcObject = destination.stream
    let result: ToneResult = 'played'
    if (sinkId && typeof element.setSinkId === 'function') {
      try {
        await element.setSinkId(sinkId)
      } catch {
        result = 'default-output'
      }
    } else if (sinkId) {
      result = 'default-output'
    }
    await element.play()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    element.pause()
    element.srcObject = null
    return result
  } catch {
    return 'failed'
  } finally {
    void ctx.close().catch(() => {})
  }
}

/** Whether this browser can direct sound at a chosen output at all. */
export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/**
 * Level meters: a bar that moves when sound is on a track.
 *
 * Reads the waveform through an AnalyserNode fed by the SDK's own track. The
 * track is only ever *read* here: never cloned, never stopped, never touched
 * in a way the SDK could notice. On iOS, stopping a clone of a capture track
 * has been seen to end the original as well, which takes the microphone away
 * from the call while the SDK still believes it has one.
 *
 * One AudioContext for the page, created when the first meter attaches and
 * resumed on the first gesture (the Join click, at the latest): browsers start
 * it suspended until the person has clicked something in THIS frame. Until
 * then the meters cannot hear anything, and every reading is qualified by
 * `metersLive()` so a bar that says "silent" never blames a microphone that is
 * fine.
 */

import { els } from './dom'

let audioContext: AudioContext | null = null
let onStateChange: () => void = () => {}

/** Called whenever the context starts or stops running; index.ts wires the UI to it. */
export function whenMetersChange(handler: () => void): void {
  onStateChange = handler
}

function context(): AudioContext | null {
  if (audioContext) return audioContext
  try {
    audioContext = new AudioContext()
  } catch {
    return null
  }
  audioContext.onstatechange = () => onStateChange()
  return audioContext
}

export function resumeAudio(): void {
  if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {})
}

/** Whether the meters can hear anything at all. */
export function metersLive(): boolean {
  return audioContext?.state === 'running'
}

export function syncMeterLabels(): void {
  const live = metersLive()
  els.previewLabel.textContent = live ? 'Say something' : 'Tap anywhere in this window to start the meter'
  els.micLevelLabel.textContent = live ? 'You — say something' : 'You — tap to start the meter'
}

export class LevelMeter {
  private track: MediaStreamTrack | null = null
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
      this.source = ctx.createMediaStreamSource(new MediaStream([track]))
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

  /** Stops listening. The track itself is left exactly as it was. */
  detach(): void {
    cancelAnimationFrame(this.frame)
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.source = null
    this.analyser = null
    this.track = null
    this.level = 0
    for (const bar of this.bars) bar.style.width = '0%'
  }
}

// The same microphone reading is shown on the preview screen and in the
// settings panel; the remote meter only exists in the panel.
export const micMeter = new LevelMeter([els.previewLevel, els.micLevel])
export const remoteMeter = new LevelMeter([els.remoteLevel])

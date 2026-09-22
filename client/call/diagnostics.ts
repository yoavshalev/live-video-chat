/**
 * What happened to the audio on this page, for when somebody says "it doesn't
 * work" from a phone nobody can attach a debugger to.
 *
 * A short timeline of track events and recovery attempts is kept in memory,
 * and on a "Fix microphone" tap — or a recovery that did not help — a snapshot
 * of it is posted to the Worker, which logs it. Device labels and truncated
 * track ids, no audio, nothing the page did not already know.
 */

import { boot } from './boot'
import { call } from './state'
import { metersLive, micMeter } from './meters'

const startedAt = Date.now()
const timeline: Array<{ t: number; event: string; detail?: unknown }> = []

/** Records an event with a timestamp relative to page load, and echoes it to the console. */
export function note(event: string, detail?: unknown): void {
  timeline.push({ t: Date.now() - startedAt, event, detail })
  if (timeline.length > 80) timeline.shift()
  console.info('[call]', event, detail ?? '')
}

function describeTrack(track: MediaStreamTrack | null | undefined) {
  if (!track) return null
  return { id: track.id.slice(0, 8), label: track.label, muted: track.muted, enabled: track.enabled, readyState: track.readyState }
}

export function snapshot(): Record<string, unknown> {
  const self = call.meeting?.self
  const peer = call.remoteParticipant
  return {
    who: boot.who,
    ua: navigator.userAgent,
    framed: window.self !== window.top,
    visibility: document.visibilityState,
    joined: call.joined,
    meters: metersLive(),
    micLevel: micMeter.level,
    audioEnabled: self?.audioEnabled ?? null,
    selfMuted: call.selfMuted,
    lastMediaError: call.lastMediaError,
    track: describeTrack(self?.audioTrack),
    device: self?.getCurrentDevices().audio?.label ?? null,
    microphones: call.microphones.length,
    peer: peer ? { audioEnabled: peer.audioEnabled ?? null, track: describeTrack(peer.audioTrack) } : null,
    recovery: { automatic: call.recovery.automatic.length, stuck: call.stuckMuted },
    timeline: timeline.slice(-40)
  }
}

export function sendDiagnostics(reason: string): Promise<void> {
  const body = JSON.stringify({ callId: boot.callId, secret: boot.secret, visitorId: boot.visitorId, reason, report: snapshot() })
  return fetch('/api/call/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true
  }).then(
    () => undefined,
    () => undefined
  )
}

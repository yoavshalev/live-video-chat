/**
 * The shape a call-page diagnostics report is allowed to have before it is
 * logged. Only known fields, each bounded; anything else is dropped. The
 * caller holds a valid call secret, but that makes them a participant, not a
 * trusted author of log lines.
 */

export interface CallReport {
  ua: string | null
  framed: boolean | null
  visibility: string | null
  joined: boolean | null
  meters: boolean | null
  micLevel: number | null
  audioEnabled: boolean | null
  selfMuted: boolean | null
  lastMediaError: string | null
  track: TrackReport | null
  device: string | null
  microphones: number | null
  peer: { audioEnabled: boolean | null; track: TrackReport | null } | null
  recovery: { automatic: number | null; stuck: boolean | null } | null
  timeline: Array<{ t: number | null; event: string | null; detail: string | null }>
}

interface TrackReport {
  id: string | null
  label: string | null
  muted: boolean | null
  enabled: boolean | null
  readyState: string | null
}

const str = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.slice(0, max) : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function track(value: unknown): TrackReport | null {
  const t = obj(value)
  if (!t) return null
  return { id: str(t.id, 8), label: str(t.label, 80), muted: bool(t.muted), enabled: bool(t.enabled), readyState: str(t.readyState, 8) }
}

export function sanitizeCallReport(raw: unknown): CallReport | null {
  const r = obj(raw)
  if (!r) return null
  const peer = obj(r.peer)
  const recovery = obj(r.recovery)
  const timeline = Array.isArray(r.timeline)
    ? r.timeline.slice(0, 40).map((entry) => {
        const e = obj(entry) ?? {}
        const detail = typeof e.detail === 'string' ? e.detail : e.detail === undefined ? null : JSON.stringify(e.detail)
        return { t: num(e.t), event: str(e.event, 40), detail: str(detail, 200) }
      })
    : []
  return {
    ua: str(r.ua, 200),
    framed: bool(r.framed),
    visibility: str(r.visibility, 10),
    joined: bool(r.joined),
    meters: bool(r.meters),
    micLevel: num(r.micLevel),
    audioEnabled: bool(r.audioEnabled),
    selfMuted: bool(r.selfMuted),
    lastMediaError: str(r.lastMediaError, 200),
    track: track(r.track),
    device: str(r.device, 80),
    microphones: num(r.microphones),
    peer: peer ? { audioEnabled: bool(peer.audioEnabled), track: track(peer.track) } : null,
    recovery: recovery ? { automatic: num(recovery.automatic), stuck: bool(recovery.stuck) } : null,
    timeline
  }
}

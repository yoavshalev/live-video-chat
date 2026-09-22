/**
 * Fixed-window rate limiting over KV.
 *
 * WHY KV AND NOT THE DURABLE OBJECT: the limits enforced here guard the paths a
 * stranger can hit *without* getting as far as the queue — opening sockets,
 * posting offline messages, minting call credentials. Sending that traffic
 * through the single coordinating Durable Object would make the DO the thing an
 * attacker exhausts, which is exactly backwards.
 *
 * KV is eventually consistent, so a determined attacker spread across regions
 * gets somewhat more than the nominal budget for a few seconds. That is an
 * acceptable trade here because the strongly-consistent limits — one queue entry
 * per visitor, one call at a time — are enforced by the state machine, where
 * correctness actually matters. This layer is about cost, not correctness.
 *
 * Turnstile: `src/routes/api.ts` marks the two endpoints that would take a token.
 * Enabling it is a site-config flag plus a verify call, deliberately left off.
 */

import type { Env } from '../types'

export interface RateLimit {
  /** Requests permitted per window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
}

export const LIMITS = {
  /** Opening a presence socket. Generous: a busy site legitimately reconnects. */
  socket: { limit: 60, windowSeconds: 60 },
  /** Joining the queue over HTTP fallback. The DO enforces the real one-per-visitor rule. */
  queueJoin: { limit: 10, windowSeconds: 300 },
  /** Offline messages. The only unauthenticated write that lands in a table I read. */
  offlineMessage: { limit: 5, windowSeconds: 3600 },
  /** Exchanging a call secret for media credentials. */
  callToken: { limit: 20, windowSeconds: 300 },
  /** Audio diagnostics from the call page. A tap on "Fix microphone" sends one. */
  callDiagnostics: { limit: 20, windowSeconds: 300 },
  /** Analytics beacons. High, because a single page view legitimately sends several. */
  analytics: { limit: 120, windowSeconds: 60 },
  /** Host password attempts, per IP. Low on purpose. */
  hostLogin: { limit: 8, windowSeconds: 900 }
} as const satisfies Record<string, RateLimit>

export interface RateVerdict {
  allowed: boolean
  remaining: number
  resetAt: number
}

/**
 * Consumes one unit from `bucket:identity`.
 *
 * Fails OPEN. If KV is unavailable the product keeps working; the alternative —
 * every visitor blocked because a rate-limit store is down — turns a degraded
 * dependency into a total outage.
 */
export async function consume(
  env: Env,
  bucket: keyof typeof LIMITS,
  identity: string
): Promise<RateVerdict> {
  const config = LIMITS[bucket]
  const now = Date.now()
  const window = Math.floor(now / (config.windowSeconds * 1000))
  const key = `rl:${bucket}:${identity}:${window}`
  const resetAt = (window + 1) * config.windowSeconds * 1000

  try {
    const current = await env.RATE.get(key)
    const used = current ? Number.parseInt(current, 10) || 0 : 0
    if (used >= config.limit) return { allowed: false, remaining: 0, resetAt }

    // Written with a TTL a window longer than needed so a counter never outlives
    // its usefulness but also never expires mid-window under clock skew.
    await env.RATE.put(key, String(used + 1), { expirationTtl: config.windowSeconds * 2 })
    return { allowed: true, remaining: Math.max(0, config.limit - used - 1), resetAt }
  } catch (error) {
    console.error('[ratelimit]', error instanceof Error ? error.message : String(error))
    return { allowed: true, remaining: config.limit, resetAt }
  }
}

/** Standard headers so a client can back off intelligently instead of hammering. */
export function rateHeaders(verdict: RateVerdict): Record<string, string> {
  return {
    'RateLimit-Remaining': String(verdict.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((verdict.resetAt - Date.now()) / 1000)))
  }
}

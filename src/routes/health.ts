/**
 * Two probes, and the difference between them is the point.
 *
 *   /health   liveness — touches nothing. Red means the Worker is gone or not
 *             routed. Safe to page on immediately.
 *   /_health  readiness — touches D1, KV, R2 and the Durable Object. Red means a
 *             dependency is degraded while the Worker itself is fine.
 *
 * With only one of them an outage in a binding and an outage in the Worker look
 * identical, and they want very different responses.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { room } from '../lib/room'
import { realtimeCredentials } from '../lib/realtimekit'

interface Probe {
  ok: boolean
  ms: number
  error?: string
}

async function probe(run: () => Promise<unknown>): Promise<Probe> {
  const started = Date.now()
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 3000ms')), 3000))
    ])
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: (error as Error).message.slice(0, 200) }
  }
}

export function register(app: Hono<AppEnv>): void {
  app.get('/health', (c) =>
    c.json({ ok: true, service: 'founderlive', check: 'liveness' }, 200, { 'Cache-Control': 'no-store' })
  )

  app.get('/_health', async (c) => {
    const checks: Record<string, Probe> = {}
    checks.d1 = await probe(() => c.env.DB.prepare('SELECT 1').first())
    checks.kv = await probe(() => c.env.RATE.get('health-probe'))
    checks.r2 = await probe(() => c.env.MEDIA.head('health-probe'))
    checks.durableObject = await probe(() => room(c.env).debugState())

    const ok = Object.values(checks).every((check) => check.ok)
    return c.json(
      {
        ok,
        service: 'founderlive',
        check: 'readiness',
        checks,
        // Not a failure: everything up to the moment a call is accepted works
        // without RealtimeKit credentials, so this is reported, not graded.
        realtimeKitConfigured: realtimeCredentials(c.env) !== null
      },
      ok ? 200 : 503,
      { 'Cache-Control': 'no-store' }
    )
  })
}

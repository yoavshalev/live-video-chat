/**
 * WebSocket entry points. Everything real-time in the product enters here.
 *
 * This file's whole job is authorisation. By the time a request reaches the
 * Durable Object it is trusted, so every check that matters — is this a real
 * site, does the Origin match it, is this actually the host — happens before the
 * upgrade is forwarded.
 *
 *   /ws/widget?siteId=…&visitorId=…   public, origin-checked against the site
 *   /ws/host                          host-authenticated
 */

import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { requireAgent } from '../lib/auth'
import { resolveSite } from '../lib/sites'
import { consume } from '../lib/ratelimit'
import { clientIp, hashIp } from '../lib/security'
import { room } from '../lib/room'
import { isSafeId, LIMITS } from '../shared/validation'

export function register(app: Hono<AppEnv>): void {
  app.get('/ws/widget', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }

    const siteId = c.req.query('siteId') ?? null
    const resolution = await resolveSite(c.env, siteId, c.req.raw)
    if (!resolution.ok) {
      // Deliberately terse. Telling an unauthorised caller which of siteId or
      // Origin was wrong helps them more than it helps us.
      return c.text('forbidden', resolution.status)
    }

    // Per-IP budget on socket opens. The DO is the scarce resource here, so the
    // limit is applied before the upgrade rather than inside it.
    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'socket', identity)
    if (!verdict.allowed) return c.text('too many connections', 429)

    const rawVisitorId = c.req.query('visitorId')
    // An id we did not issue is simply ignored — the socket still connects and
    // still shows presence, it just has no queue identity.
    const visitorId = isSafeId(rawVisitorId, LIMITS.visitorId) ? rawVisitorId : undefined
    // `waiting_visitor` unlocks targeted messages (position, invitation); a plain
    // `widget` gets presence only.
    const role = visitorId ? 'waiting_visitor' : 'widget'

    const target = new URL('https://room/connect')
    target.searchParams.set('role', role)
    target.searchParams.set('siteId', resolution.site.id)
    if (visitorId) target.searchParams.set('visitorId', visitorId)

    return room(c.env).fetch(new Request(target, c.req.raw))
  })

  app.get('/ws/host', requireAgent(), async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }
    // requireAgent() verified the session AND that the agent is still enabled.
    // The identity travels to the Durable Object as query parameters on an
    // internal URL the browser never sees; the DO trusts it because only this
    // Worker can reach it.
    const agent = c.get('agent')
    if (!agent) return c.json({ error: 'unauthorized' }, 401)
    const target = new URL('https://room/connect')
    target.searchParams.set('role', 'host')
    target.searchParams.set('agentId', agent.agentId)
    target.searchParams.set('agentName', agent.name)
    target.searchParams.set('agentRole', agent.role)
    return room(c.env).fetch(new Request(target, c.req.raw))
  })
}

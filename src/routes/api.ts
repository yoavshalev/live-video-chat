/**
 * The public JSON API the widget and the call page talk to.
 *
 * Every route here is reachable from a page we do not control, so each one either
 * validates `siteId` against the browser-supplied `Origin` (`resolveSite`) or
 * requires a secret that was handed to exactly one browser (`callSecret`).
 *
 * TURNSTILE: the two endpoints marked below are the ones that would take a token
 * if abuse ever justifies it — they are the only unauthenticated writes. Enabling
 * it is a site-config flag, a hidden field, and a verify call; nothing else here
 * would change. Left off deliberately: a CAPTCHA in front of "talk to the
 * founder" costs more conversions than the abuse costs us today.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { DEFAULT_AGENT_LABEL, corsHeaders, getSite, resolveSite } from '../lib/sites'
import { consume } from '../lib/ratelimit'
import { clientIp, hashIp } from '../lib/security'
import { room } from '../lib/room'
import { insertOfflineMessage } from '../lib/db'
import { EVENT_NAMES, recordEvents } from '../lib/analytics'
import { isSafeId, LIMITS, sanitizeEmail, sanitizeText, sanitizeUrl } from '../shared/validation'

export function register(app: Hono<AppEnv>): void {
  // Preflight for every embedded call. Answered only for origins that belong to
  // the site being claimed, so it is not a blanket CORS opener.
  const handlePreflight = async (c: Context<AppEnv>) => {
    const siteId = c.req.query('siteId') ?? null
    const resolution = await resolveSite(c.env, siteId, c.req.raw)
    if (!resolution.ok) return c.text('forbidden', resolution.status)
    return c.body(null, 204, corsHeaders(resolution.origin))
  }

  app.options('/embed/*', handlePreflight)
  app.options('/api/*', handlePreflight)

  /**
   * Everything the widget needs to render its first frame without waiting for a
   * socket: theme, position, the host's profile, and current presence. Cached for
   * a few seconds at the edge because a burst of page views asks the same
   * question, but short enough that a stale answer is corrected by the socket
   * within a blink anyway.
   */
  app.get('/embed/config', async (c) => {
    const siteId = c.req.query('siteId') ?? null
    const resolution = await resolveSite(c.env, siteId, c.req.raw)
    if (!resolution.ok) return c.json({ error: resolution.reason }, resolution.status)

    const snapshot = await room(c.env).snapshot()
    return c.json(
      {
        site: {
          id: resolution.site.id,
          theme: resolution.site.theme,
          position: resolution.site.position,
          accentColor: resolution.site.accentColor,
          customGreeting: resolution.site.customGreeting,
          offlineMode: resolution.site.offlineMode,
          agentLabel: resolution.site.agentLabel ?? DEFAULT_AGENT_LABEL
        },
        host: snapshot.hostProfile,
        presence: snapshot.presence,
        wsUrl: `${c.env.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/ws/widget`,
        callUrl: `${c.env.PUBLIC_BASE_URL}/call`
      },
      200,
      { ...corsHeaders(resolution.origin), 'Cache-Control': 'public, max-age=5' }
    )
  })

  /**
   * Analytics beacon. Accepts a batch because `navigator.sendBeacon` fires once
   * on unload and we would rather lose nothing than chatter all session.
   *
   * Returns 204 before the write completes — measurement never delays the UI.
   */
  app.post('/api/events', async (c) => {
    const siteId = c.req.query('siteId') ?? null
    const resolution = await resolveSite(c.env, siteId, c.req.raw)
    if (!resolution.ok) return c.json({ error: resolution.reason }, resolution.status)

    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'analytics', identity)
    if (!verdict.allowed) return c.body(null, 204, corsHeaders(resolution.origin))

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid json' }, 400, corsHeaders(resolution.origin))
    }

    const raw = Array.isArray(body) ? body : [body]
    const events = raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      // An unknown event name is dropped rather than stored: the table is a fixed
      // funnel, not a free-form log, and an open write endpoint that accepts any
      // string is an open write endpoint.
      .filter((item) => typeof item.name === 'string' && EVENT_NAMES.has(item.name))
      .slice(0, 20)
      .map((item) => ({
        name: String(item.name),
        siteId: resolution.site.id,
        visitorId: isSafeId(item.visitorId, LIMITS.visitorId) ? item.visitorId : null,
        pageUrl: sanitizeUrl(item.pageUrl),
        props:
          typeof item.props === 'object' && item.props !== null
            ? (item.props as Record<string, unknown>)
            : null
      }))

    c.executionCtx.waitUntil(recordEvents(c.env, events))
    return c.body(null, 204, corsHeaders(resolution.origin))
  })

  /**
   * The offline path. TURNSTILE CANDIDATE #1 — an unauthenticated write into a
   * table a human reads.
   */
  app.post('/api/offline-message', async (c) => {
    const siteId = c.req.query('siteId') ?? null
    const resolution = await resolveSite(c.env, siteId, c.req.raw)
    if (!resolution.ok) return c.json({ error: resolution.reason }, resolution.status)
    const cors = corsHeaders(resolution.origin)

    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'offlineMessage', identity)
    if (!verdict.allowed) {
      return c.json({ error: 'Too many messages — try again later.' }, 429, cors)
    }

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid json' }, 400, cors)
    }

    const name = sanitizeText(body.name, LIMITS.firstName)
    const message = sanitizeText(body.message, LIMITS.message)
    if (!name || !message) return c.json({ error: 'Name and message are required.' }, 400, cors)

    const id = await insertOfflineMessage(c.env, {
      siteId: resolution.site.id,
      visitorId: isSafeId(body.visitorId, LIMITS.visitorId) ? body.visitorId : null,
      name,
      email: sanitizeEmail(body.email),
      message,
      pageUrl: sanitizeUrl(body.pageUrl)
    })

    c.executionCtx.waitUntil(
      recordEvents(c.env, [
        {
          name: 'offline_message_sent',
          siteId: resolution.site.id,
          visitorId: isSafeId(body.visitorId, LIMITS.visitorId) ? body.visitorId : null,
          pageUrl: sanitizeUrl(body.pageUrl)
        }
      ])
    )
    return c.json({ ok: true, id }, 200, cors)
  })

  /**
   * Trades a call secret for RealtimeKit credentials. TURNSTILE CANDIDATE #2,
   * though the secret already makes this useless to guess at.
   *
   * Called same-origin by /call, so there is no CORS here by design: the call page
   * is ours, and no embedding site should ever be able to ask for media
   * credentials directly.
   */
  app.post('/api/call/credentials', async (c) => {
    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'callToken', identity)
    if (!verdict.allowed) return c.json({ error: 'rate limited' }, 429)

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }

    const callId = body.callId
    const secret = body.secret
    const who = body.who === 'host' ? 'host' : 'visitor'
    if (!isSafeId(callId, 64) || typeof secret !== 'string' || secret.length < 16) {
      return c.json({ error: 'invalid request' }, 400)
    }

    // Claiming the agent seat requires being a signed-in agent — and, checked in
    // the Durable Object, the agent this call belongs to. Without this the
    // callSecret alone would let the visitor take the agent's seat and its
    // permissions.
    const agent = c.get('agent')
    if (who === 'host' && !agent) return c.json({ error: 'unauthorized' }, 401)

    const visitorId = isSafeId(body.visitorId, LIMITS.visitorId) ? body.visitorId : undefined
    const result = await room(c.env).redeemCall({ callId, secret, who, visitorId, agentId: agent?.agentId })
    if (!result.ok) {
      // 409 for "not ready yet" so the call page can retry; 403 for a bad secret,
      // which it never should.
      const status = result.error === 'not_ready' ? 409 : 403
      return c.json({ error: result.error }, status)
    }
    return c.json(
      {
        meetingId: result.meetingId,
        authToken: result.authToken,
        displayName: result.displayName
      },
      200,
      { 'Cache-Control': 'no-store' }
    )
  })

  /**
   * Media presence, for the case where the call page was opened as a top-level
   * tab (the iframe-permissions fallback) and therefore has no parent window to
   * relay through. In the normal path the widget reports this over its existing
   * socket instead.
   */
  app.post('/api/call/presence', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const callId = body.callId
    const secret = body.secret
    const who = body.who === 'host' ? 'host' : 'visitor'
    if (!isSafeId(callId, 64) || typeof secret !== 'string') return c.json({ error: 'invalid request' }, 400)
    const agent = c.get('agent')
    if (who === 'host' && !agent) return c.json({ error: 'unauthorized' }, 401)

    const visitorId = isSafeId(body.visitorId, LIMITS.visitorId) ? body.visitorId : undefined
    // Re-checking the secret costs one storage read and means this endpoint cannot
    // be used to end somebody else's call by guessing an id.
    const check = await room(c.env).redeemCall({ callId, secret, who, visitorId, agentId: agent?.agentId })
    if (!check.ok && check.error !== 'not_ready') return c.json({ error: check.error }, 403)

    await room(c.env).mediaPresence({ callId, who, joined: body.joined === true })
    return c.body(null, 204)
  })

  /** Used by the dashboard's embed-snippet panel. Host-only data, so no CORS. */
  app.get('/api/sites/:siteId', async (c) => {
    if (!c.get('agent')) return c.json({ error: 'unauthorized' }, 401)
    const site = await getSite(c.env, c.req.param('siteId'))
    if (!site) return c.json({ error: 'not found' }, 404)
    return c.json(site)
  })
}

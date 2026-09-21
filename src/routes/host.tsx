/**
 * The agent dashboard — the private control surface for every embedded widget.
 *
 * Five tabs, because they are five different jobs done at different times:
 *
 *   Live   — what an agent looks at while people are waiting and while they
 *            talk. Their own call fills the main area; the sidebar is who is
 *            next, where they came from, and what the other agents are doing.
 *   Embed  — sites, their domains, and the snippet to paste. Admins.
 *   Clip   — the intro loop for the organization.
 *   Inbox  — everyone who ever filled out a form.
 *   Agents — the team: who can sign in, and your own password.
 *
 * Server-rendered skeleton, hydrated by client/host/index.ts over the WebSocket.
 * Everything that moves — status, queue, calls, other agents — is owned by the
 * socket, because a dashboard that needs refreshing is a dashboard that lies to
 * you while somebody waits.
 */

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { AppEnv } from '../types'
import { BASE_STYLES, HOST_STYLES } from '../ui/styles'
import { authenticatePassword, clearAgentSession, createAgentSession, requireAgent } from '../lib/auth'
import { hashPassword, passwordProblem, verifyPassword } from '../lib/password'
import { consume } from '../lib/ratelimit'
import { clientIp, hashIp } from '../lib/security'
import { addDomain, createSite, listSites, removeDomain, updateSiteSettings } from '../lib/sites'
import {
  countEnabledAdmins, createAgent, getAgentById, getHostProfile, getTodayMetrics, listAgents, listInbox,
  listOfflineMessages, recentSessions, startOfTodayUtc, summarize, updateAgent
} from '../lib/db'
import { room } from '../lib/room'
import { listPresets, realtimeCredentials } from '../lib/realtimekit'
import hostAppSource from '../generated/host.js'

function layout(title: string, body: unknown, extraStyles = '') {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title}</title>
    <style>
      ${raw(BASE_STYLES)}
      ${raw(extraStyles)}
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`
}

export function register(app: Hono<AppEnv>): void {
  // ── Sign in (password mode only) ─────────────────────────────────────────
  //
  // In `access` mode Cloudflare Access handles sign-in in front of the Worker and
  // this page is never reached, so it redirects rather than offering a second,
  // weaker way in.

  app.get('/host/login', (c) => {
    if (c.env.HOST_AUTH_MODE === 'access') return c.redirect('/host')
    if (c.get('agent')) return c.redirect('/host')
    const next = c.req.query('next') ?? '/host'
    const error = c.req.query('error')

    return c.html(
      layout(
        'Sign in',
        html`<div style="display:grid;place-items:center;min-height:100vh;padding:20px">
          <form method="post" action="/host/login" class="card stack" style="width:100%;max-width:360px">
            <div>
              <h1>Live video chat</h1>
              <p class="muted small" style="margin:6px 0 0">Agent dashboard</p>
            </div>
            ${error
              ? html`<div class="small" style="color:var(--danger)">
                  ${error === 'rate' ? 'Too many attempts. Wait a few minutes.' : 'That email and password do not match.'}
                </div>`
              : ''}
            <input type="hidden" name="next" value="${next}" />
            <div>
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="username" autofocus required />
            </div>
            <div>
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required />
            </div>
            <button class="btn-primary" type="submit">Sign in</button>
            <p class="tiny muted" style="margin:0">
              No account yet? An admin adds you on the Agents tab, or from the command line:
              <span class="mono">node scripts/agent.mjs add</span>
            </p>
          </form>
        </div>`
      )
    )
  })

  app.post('/host/login', async (c) => {
    if (c.env.HOST_AUTH_MODE === 'access') return c.redirect('/host')

    // Per-IP and deliberately low. Passwords with no lockout are passwords that
    // get guessed eventually.
    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'hostLogin', identity)
    if (!verdict.allowed) return c.redirect('/host/login?error=rate')

    const form = await c.req.formData()
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    const next = String(form.get('next') ?? '/host')
    const agent = await authenticatePassword(c.env, email, password)
    if (!agent) return c.redirect('/host/login?error=1')

    await createAgentSession(c, agent)
    // Only same-origin paths, so `next` cannot be turned into an open redirect.
    return c.redirect(next.startsWith('/') ? next : '/host')
  })

  app.post('/host/logout', (c) => {
    clearAgentSession(c)
    return c.redirect('/host/login')
  })

  // ── Dashboard client bundle ──────────────────────────────────────────────
  app.get('/host/app.js', requireAgent(), (c) =>
    c.body(hostAppSource, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'private, max-age=60'
    })
  )

  // ── Read APIs ────────────────────────────────────────────────────────────
  app.get('/api/host/metrics', requireAgent(), async (c) => c.json(await getTodayMetrics(c.env)))
  app.get('/api/host/recent', requireAgent(), async (c) => c.json({ sessions: await recentSessions(c.env, startOfTodayUtc()) }))
  app.get('/api/host/messages', requireAgent(), async (c) => c.json({ messages: await listOfflineMessages(c.env, 50) }))
  app.get('/api/host/inbox', requireAgent(), async (c) => c.json({ items: await listInbox(c.env, 100) }))
  app.get('/api/host/room', requireAgent(), async (c) => c.json(await room(c.env).debugState()))

  /**
   * What RealtimeKit thinks this app looks like. The preset names here are the
   * ones REALTIMEKIT_HOST_PRESET / REALTIMEKIT_VISITOR_PRESET must match — they
   * vary by how the app was created, and a mismatch is invisible until the first
   * accepted call fails.
   */
  app.get('/api/host/realtimekit', requireAgent(), async (c) => {
    if (!realtimeCredentials(c.env)) {
      return c.json({ configured: false, presets: [], note: 'Set CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN.' })
    }
    try {
      const presets = await listPresets(c.env)
      return c.json({
        configured: true,
        presets,
        using: { host: c.env.REALTIMEKIT_HOST_PRESET, visitor: c.env.REALTIMEKIT_VISITOR_PRESET },
        ok: presets.includes(c.env.REALTIMEKIT_HOST_PRESET) && presets.includes(c.env.REALTIMEKIT_VISITOR_PRESET)
      })
    } catch (error) {
      return c.json({ configured: true, error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  // ── Site management (admins) ─────────────────────────────────────────────
  app.get('/api/host/sites', requireAgent(), async (c) => c.json({ sites: await listSites(c.env) }))

  app.post('/api/host/sites', requireAgent({ admin: true }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; name?: unknown }
    const result = await createSite(c.env, {
      id: typeof body.id === 'string' ? body.id : '',
      name: typeof body.name === 'string' ? body.name : ''
    })
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ site: result.site })
  })

  app.post('/api/host/sites/:id/domains', requireAgent({ admin: true }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { domain?: unknown }
    const result = await addDomain(c.env, c.req.param('id'), typeof body.domain === 'string' ? body.domain : '')
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ site: result.site })
  })

  app.delete('/api/host/sites/:id/domains/:domain', requireAgent({ admin: true }), async (c) => {
    const result = await removeDomain(c.env, c.req.param('id'), decodeURIComponent(c.req.param('domain')))
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ site: result.site })
  })

  app.patch('/api/host/sites/:id', requireAgent({ admin: true }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; offlineMode?: unknown; agentLabel?: unknown }
    const patch: Parameters<typeof updateSiteSettings>[2] = {}
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
      patch.enabled = body.enabled
    }
    if (body.offlineMode !== undefined) {
      if (body.offlineMode !== 'show' && body.offlineMode !== 'hide') return c.json({ error: 'offlineMode must be show or hide' }, 400)
      patch.offlineMode = body.offlineMode
    }
    if (body.agentLabel !== undefined) {
      if (typeof body.agentLabel !== 'string') return c.json({ error: 'agentLabel must be a string' }, 400)
      patch.agentLabel = body.agentLabel
    }
    const result = await updateSiteSettings(c.env, c.req.param('id'), patch)
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ site: result.site })
  })

  // ── Agent management ─────────────────────────────────────────────────────
  //
  // Anyone can see the team. Only admins change it, and the last enabled admin
  // can be neither demoted nor disabled — an organization with no admin is one
  // nobody can fix from the dashboard.

  app.get('/api/host/agents', requireAgent(), async (c) => c.json({ agents: (await listAgents(c.env)).map(summarize) }))

  app.post('/api/host/agents', requireAgent({ admin: true }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; email?: unknown; password?: unknown; role?: unknown }
    const name = typeof body.name === 'string' ? body.name : ''
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (c.env.HOST_AUTH_MODE !== 'access') {
      const problem = passwordProblem(password)
      if (problem) return c.json({ error: problem }, 400)
    }
    const result = await createAgent(c.env, {
      name,
      email,
      passwordHash: c.env.HOST_AUTH_MODE === 'access' ? null : await hashPassword(password),
      role: body.role === 'admin' ? 'admin' : 'agent'
    })
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ agent: summarize(result.agent) })
  })

  app.patch('/api/host/agents/:id', requireAgent({ admin: true }), async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; role?: unknown; enabled?: unknown; password?: unknown }
    const target = await getAgentById(c.env, id)
    if (!target) return c.json({ error: 'unknown agent' }, 404)

    const patch: Parameters<typeof updateAgent>[2] = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (body.role === 'admin' || body.role === 'agent') patch.role = body.role
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.password === 'string') {
      const problem = passwordProblem(body.password)
      if (problem) return c.json({ error: problem }, 400)
      patch.passwordHash = await hashPassword(body.password)
    }

    const losingAdmin = target.role === 'admin' && target.enabled === 1 && (patch.role === 'agent' || patch.enabled === false)
    if (losingAdmin && (await countEnabledAdmins(c.env)) <= 1) {
      return c.json({ error: 'That is the last admin. Make somebody else an admin first.' }, 409)
    }

    const result = await updateAgent(c.env, id, patch)
    if (!result.ok) return c.json({ error: result.reason }, result.status)
    return c.json({ agent: summarize(result.agent) })
  })

  /** Your own password. Needs the current one, so a stolen session cannot lock you out. */
  app.post('/api/host/me/password', requireAgent(), async (c) => {
    if (c.env.HOST_AUTH_MODE === 'access') return c.json({ error: 'Passwords are managed by your identity provider.' }, 400)
    const me = c.get('agent')
    if (!me) return c.json({ error: 'unauthorized' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { current?: unknown; next?: unknown }
    const current = typeof body.current === 'string' ? body.current : ''
    const next = typeof body.next === 'string' ? body.next : ''
    const problem = passwordProblem(next)
    if (problem) return c.json({ error: problem }, 400)
    const record = await getAgentById(c.env, me.agentId)
    if (!record || !(await verifyPassword(record.password_hash, current))) return c.json({ error: 'Current password is wrong.' }, 403)
    await updateAgent(c.env, me.agentId, { passwordHash: await hashPassword(next) })
    return c.json({ ok: true })
  })

  // ── The dashboard ────────────────────────────────────────────────────────
  app.get('/host', requireAgent(), async (c) => {
    const me = c.get('agent')
    if (!me) return c.redirect('/host/login')
    const [metrics, sites, profile, recent, agents] = await Promise.all([
      getTodayMetrics(c.env),
      listSites(c.env),
      getHostProfile(c.env, c.env.ORG_ID),
      recentSessions(c.env, startOfTodayUtc()),
      listAgents(c.env)
    ])
    const orgName = profile?.displayName ?? c.env.ORG_ID
    const base = c.env.PUBLIC_BASE_URL
    const isAdmin = me.role === 'admin'

    return c.html(
      layout(
        `${orgName} · Live`,
        html`
          <div class="shell">
            <header class="top">
              <div class="brand">
                <span id="status-dot" class="dot offline" aria-hidden="true"></span>
                <span>${orgName}</span>
                <span id="status-label" class="status-label muted">Connecting…</span>
              </div>

              <nav class="tabs" role="tablist" aria-label="Dashboard sections">
                <button class="tab" role="tab" data-tab="live" aria-selected="true" type="button">Live</button>
                ${isAdmin ? html`<button class="tab" role="tab" data-tab="embed" aria-selected="false" type="button">Embed</button>` : ''}
                <button class="tab" role="tab" data-tab="clip" aria-selected="false" type="button">Clip</button>
                <button class="tab" role="tab" data-tab="inbox" aria-selected="false" type="button">Inbox</button>
                <button class="tab" role="tab" data-tab="agents" aria-selected="false" type="button">Agents</button>
              </nav>

              <div class="row">
                <span class="badge site" title="Signed in as ${me.email}">${me.name}</span>
                <!-- Alert sound. A repeating chime while somebody waits and you are
                     free. Persisted per browser; see client/host/alerts.ts. -->
                <button id="btn-sound" class="btn-ghost" type="button" aria-pressed="true" title="Chime while someone is waiting">Sound on</button>
                <button id="btn-check" class="btn-ghost" type="button">Check camera</button>
                <button id="btn-pause" class="btn-ghost hidden" type="button">Pause new requests</button>
                <button id="btn-live" class="btn-live" type="button" disabled>Go live</button>
                ${c.env.HOST_AUTH_MODE === 'access' ? '' : html`<form method="post" action="/host/logout"><button class="btn-ghost" type="submit">Sign out</button></form>`}
              </div>
            </header>

            <p id="live-region" class="hidden" role="status" aria-live="polite"></p>

            <!-- Browsers refuse to play sound until you have clicked something on
                 the page. After a reload you may not have, so a join that arrives
                 first cannot ring — this says so, and any click fixes it. -->
            <div id="sound-locked" class="banner hidden" role="status">
              <strong>Someone is waiting</strong> — click anywhere to turn on the alert sound.
            </div>

            <!-- ═══ LIVE ═══════════════════════════════════════════════════ -->
            <section id="tab-live" class="tab-panel" role="tabpanel">
              <div class="metrics" style="margin-bottom:18px">
                <div class="metric"><div class="value" id="m-calls">${metrics.callsCompleted}</div><div class="label">Calls today</div></div>
                <div class="metric"><div class="value" id="m-joins">${metrics.queueJoins}</div><div class="label">Joined the line today</div></div>
                <div class="metric"><div class="value" id="m-avg">${metrics.averageCallSeconds ? `${Math.round(metrics.averageCallSeconds / 60)}m` : '—'}</div><div class="label">Avg call</div></div>
                <div class="metric"><div class="value" id="m-waiting">0</div><div class="label">Waiting now</div></div>
              </div>

              <div class="live-grid">
                <div class="stack">
                  <section id="call-panel" class="card stack hidden" aria-label="Your call">
                    <div class="between">
                      <div class="row">
                        <span class="dot busy" aria-hidden="true"></span>
                        <strong id="call-name">—</strong>
                        <span id="call-site" class="badge site"></span>
                      </div>
                      <div class="row">
                        <span id="call-timer" class="mono muted">0:00</span>
                        <button id="btn-end" class="btn-danger" type="button">End call</button>
                      </div>
                    </div>
                    <div class="call-stage" id="call-stage"></div>
                    <p id="call-question" class="small muted" style="margin:0"></p>
                  </section>

                  <section id="idle-panel" class="card idle" aria-label="Status">
                    <div class="idle-inner">
                      <span id="idle-dot" class="dot offline big" aria-hidden="true"></span>
                      <h2 id="idle-title">You're offline</h2>
                      <p id="idle-body" class="muted" style="margin:0">Go live and every widget switches on within a second.</p>
                      <div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:6px">
                        <button id="btn-accept-next" class="btn-primary" type="button" disabled>Accept next</button>
                        <label class="row small muted" style="margin:0;gap:6px">
                          Assignment
                          <select id="assignment" style="width:auto">
                            <option value="auto">Automatic — round-robin to whoever is free</option>
                            <option value="manual">Manual — agents press Accept</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  </section>
                </div>

                <aside class="stack">
                  <section class="card stack" aria-label="Queue">
                    <div class="between">
                      <h2>Up next</h2>
                      <span id="queue-count" class="badge">0</span>
                    </div>
                    <div id="queue" class="stack"></div>
                    <div id="queue-empty" class="empty">Nobody is waiting right now.</div>
                  </section>

                  <section class="card stack" aria-label="Agents">
                    <div class="between">
                      <h2>Agents</h2>
                      <span id="agents-live" class="badge">0 live</span>
                    </div>
                    <div id="agents-live-list" class="stack"></div>
                  </section>

                  <section class="card stack" aria-label="Earlier today">
                    <h2>Earlier today</h2>
                    <p class="tiny muted" style="margin:0">
                      Everyone who joined the line today and what happened. A join that expired while
                      nobody was watching shows up here and nowhere else.
                    </p>
                    <div id="recent" class="stack">
                      ${recent.length === 0
                        ? html`<div class="empty">No one yet today.</div>`
                        : recent.map(
                            (r) => html`<div class="recent-row">
                              <span class="name">${r.firstName}</span>
                              <span class="badge site">${r.siteId}</span>
                              <span class="badge outcome ${r.status}">${r.status.replace('_', ' ')}</span>
                              ${r.agentName ? html`<span class="badge">${r.agentName}</span>` : ''}
                              <span class="tiny muted when" data-at="${r.joinedAt}"></span>
                            </div>`
                          )}
                    </div>
                  </section>
                </aside>
              </div>
            </section>

            <!-- ═══ EMBED (admins) ═════════════════════════════════════════ -->
            <section id="tab-embed" class="tab-panel hidden" role="tabpanel">
              <div class="embed-grid">
                <div class="stack">
                  <section class="card stack">
                    <h2>How domains work</h2>
                    <p class="small muted" style="margin:0">
                      Each site lists <strong>root domains</strong>. A root covers itself and every subdomain:
                      <code class="mono">example.com</code> admits example.com, www.example.com and app.example.com.
                      Only https is accepted, except <code class="mono">localhost</code> for local development.
                    </p>
                    <p class="small muted" style="margin:0">
                      A page on a domain that is not listed sees nothing — the widget refuses to load
                      rather than showing an error. Changes take effect within a minute.
                    </p>
                  </section>

                  <section class="card stack">
                    <h2>Add a site</h2>
                    <form id="site-form" class="stack">
                      <div class="two">
                        <div>
                          <label for="site-name">Name</label>
                          <input id="site-name" type="text" maxlength="60" placeholder="My website" required />
                        </div>
                        <div>
                          <label for="site-id">Id <span class="muted">(used in the snippet)</span></label>
                          <input id="site-id" type="text" maxlength="40" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" placeholder="my-website" required />
                        </div>
                      </div>
                      <button class="btn-primary" type="submit">Create site</button>
                    </form>
                  </section>
                </div>
                <div id="sites" class="stack"></div>
              </div>
            </section>

            <!-- ═══ INBOX ══════════════════════════════════════════════════ -->
            <section id="tab-inbox" class="tab-panel hidden" role="tabpanel">
              <section class="card stack">
                <div class="between">
                  <h2>Inbox</h2>
                  <button id="btn-inbox-refresh" class="btn-ghost" type="button">Refresh</button>
                </div>
                <p class="small muted" style="margin:0">
                  Everyone who filled out a form: <strong>join requests</strong> (name, email, what they
                  wanted to talk about, who took the call and whether it happened) and <strong>offline
                  messages</strong> left while nobody was live. Newest first.
                </p>
                <div id="inbox" class="stack"><div class="empty">Loading…</div></div>
              </section>
            </section>

            <!-- ═══ CLIP ═══════════════════════════════════════════════════ -->
            <section id="tab-clip" class="tab-panel hidden" role="tabpanel">
              <div class="clip-grid">
                <section class="card stack" aria-label="Intro clip">
                  <h2>Intro clip</h2>
                  <p class="small muted" style="margin:0">
                    A 5–15s loop, shown while anyone is live and labelled as an intro, never as a live feed.
                    Visitors see it muted with an unmute button — browsers refuse to autoplay sound — so lead
                    with a face, not a sentence that needs audio. One clip for the whole organization.
                  </p>
                  <div id="loop-wrap" class="clip-preview${profile?.loopVideoUrl ? '' : ' hidden'}">
                    <video id="loop-preview" ${profile?.loopVideoUrl ? html`src="${profile.loopVideoUrl}"` : ''} muted playsinline autoplay></video>
                    <button id="loop-sound" class="media-sound off" type="button" aria-pressed="false">Sound off</button>
                  </div>
                  ${profile?.loopVideoUrl ? '' : html`<p id="loop-empty" class="small muted" style="margin:0">No clip yet. The widget shows a designed fallback until someone records one.</p>`}
                  <button id="btn-record" class="btn-primary" type="button">Record a new clip</button>
                  <details>
                    <summary class="tiny muted" style="cursor:pointer">Or upload a file</summary>
                    <form id="loop-form" enctype="multipart/form-data" class="stack" style="margin-top:10px">
                      <input id="loop-file" type="file" name="file" accept="video/mp4,video/webm" />
                      <button class="btn-ghost" type="submit">Upload clip</button>
                    </form>
                  </details>
                  <p id="loop-status" class="tiny muted" style="margin:0"></p>
                </section>

                <section class="card stack" aria-label="Tips">
                  <h2>What works</h2>
                  <ul class="small muted tips">
                    <li>Look at the lens, not the screen. Five seconds of eye contact does the job.</li>
                    <li>Record in the light you'll actually be in when you go live.</li>
                    <li>Re-record often. A clip that says "here's what we're working on today" is the whole point.</li>
                    <li>MP4 plays everywhere. If the recorder says it made WebM, iPhones show the still frame instead — Safari records MP4 natively.</li>
                  </ul>
                </section>
              </div>
            </section>

            <!-- ═══ AGENTS ═════════════════════════════════════════════════ -->
            <section id="tab-agents" class="tab-panel hidden" role="tabpanel">
              <div class="embed-grid">
                <div class="stack">
                  ${c.env.HOST_AUTH_MODE === 'access'
                    ? html`<section class="card stack">
                        <h2>Your sign-in</h2>
                        <p class="small muted" style="margin:0">
                          Sign-in is handled by Cloudflare Access. Anyone your Access policy admits becomes an
                          agent the first time they open this page; admins can change roles below.
                        </p>
                      </section>`
                    : html`<section class="card stack">
                        <h2>Change your password</h2>
                        <form id="password-form" class="stack">
                          <div>
                            <label for="pw-current">Current password</label>
                            <input id="pw-current" type="password" autocomplete="current-password" required />
                          </div>
                          <div>
                            <label for="pw-next">New password <span class="muted">(12+ characters)</span></label>
                            <input id="pw-next" type="password" autocomplete="new-password" minlength="12" required />
                          </div>
                          <button class="btn-ghost" type="submit">Update password</button>
                          <p id="pw-status" class="tiny muted" style="margin:0"></p>
                        </form>
                      </section>`}

                  ${isAdmin
                    ? html`<section class="card stack">
                        <h2>Add an agent</h2>
                        <form id="agent-form" class="stack">
                          <div class="two">
                            <div>
                              <label for="agent-name">Name</label>
                              <input id="agent-name" type="text" maxlength="60" placeholder="Ariel" required />
                            </div>
                            <div>
                              <label for="agent-email">Email</label>
                              <input id="agent-email" type="email" maxlength="120" required />
                            </div>
                          </div>
                          ${c.env.HOST_AUTH_MODE === 'access'
                            ? ''
                            : html`<div>
                                <label for="agent-password">Temporary password <span class="muted">(12+ characters; they can change it)</span></label>
                                <input id="agent-password" type="text" minlength="12" maxlength="200" autocomplete="off" required />
                              </div>`}
                          <label class="switch"><input id="agent-admin" type="checkbox" /> Admin — can manage sites and agents</label>
                          <button class="btn-primary" type="submit">Add agent</button>
                        </form>
                      </section>`
                    : ''}
                </div>

                <section class="card stack">
                  <div class="between">
                    <h2>Team</h2>
                    <span class="tiny muted">${isAdmin ? 'You can change roles and disable accounts.' : 'Ask an admin to make changes.'}</span>
                  </div>
                  <div id="agents-list" class="stack"></div>
                </section>
              </div>
            </section>
          </div>

          <!-- Camera surface: device check and the in-browser recorder. -->
          <div id="media-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="media-title">
            <div class="modal-card">
              <div class="between">
                <h2 id="media-title">Camera and microphone</h2>
                <button id="media-close" class="btn-ghost" type="button">Close</button>
              </div>
              <p id="media-hint" class="small muted" style="margin:0"></p>
              <div class="media-stage">
                <video id="media-preview" autoplay playsinline muted></video>
                <video id="media-playback" class="hidden" playsinline loop></video>
                <span id="media-timer" class="media-timer hidden">0.0s</span>
                <button id="media-sound" class="media-sound hidden" type="button" aria-pressed="true">Sound on</button>
              </div>
              <div>
                <label style="margin-bottom:5px">Microphone level</label>
                <div id="media-level" class="level"><i id="media-level-bar"></i></div>
              </div>
              <div class="device-grid">
                <div><label for="media-camera">Camera</label><select id="media-camera"></select></div>
                <div><label for="media-mic">Microphone</label><select id="media-mic"></select></div>
              </div>
              <div id="media-error" class="error-box hidden" role="alert"></div>
              <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
                <button id="media-record" class="btn-danger hidden" type="button">Start recording</button>
                <button id="media-stop" class="btn-ghost hidden" type="button">Stop</button>
                <button id="media-retake" class="btn-ghost hidden" type="button">Retake</button>
                <button id="media-use" class="btn-primary hidden" type="button">Use this clip</button>
              </div>
            </div>
          </div>

          <div id="toasts" class="toast-wrap"></div>
          <script type="application/json" id="boot">
            ${raw(
              JSON.stringify({
                baseUrl: base,
                orgId: c.env.ORG_ID,
                orgName,
                authMode: c.env.HOST_AUTH_MODE,
                me: { agentId: me.agentId, name: me.name, email: me.email, role: me.role },
                wsUrl: `${base.replace(/^http/, 'ws')}/ws/host`,
                sites,
                agents: agents.map(summarize)
              })
            )}
          </script>
          <script type="module" src="/host/app.js"></script>
        `,
        HOST_STYLES
      )
    )
  })

  app.get('/', (c) => c.redirect('/host'))
}

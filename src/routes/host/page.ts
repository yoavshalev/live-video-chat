/**
 * The dashboard page — the private control surface for every embedded widget.
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
 * Server-rendered skeleton, hydrated by client/host/ over the WebSocket.
 * Everything that moves — status, queue, calls, other agents — is owned by the
 * socket, because a dashboard that needs refreshing is a dashboard that lies to
 * you while somebody waits.
 */

import type { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { AppEnv } from '../../types'
import { HOST_STYLES } from '../../ui/styles'
import { requireAgent } from '../../lib/auth'
import { listSites } from '../../lib/sites'
import { getHostProfile, getTodayMetrics, listAgents, recentSessions, startOfTodayUtc, summarize } from '../../lib/db'
import { layout, type Html } from './layout'
import { header } from './tabs/header'
import { liveTab } from './tabs/live'
import { embedTab } from './tabs/embed'
import { inboxTab } from './tabs/inbox'
import { clipTab } from './tabs/clip'
import { agentsTab } from './tabs/agents'
import { mediaModal } from './tabs/media-modal'
import { publicBaseUrl } from '../../lib/base-url'
import { realtimeCredentials } from '../../lib/realtimekit'

export function registerDashboard(app: Hono<AppEnv>): void {
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
    const base = publicBaseUrl(c.env, c.req.raw)
    const authMode = c.env.HOST_AUTH_MODE
    const isAdmin = me.role === 'admin'

    // What the client needs before its socket opens. Sites and the team are
    // included so the Embed and Agents tabs render without a second round trip.
    const boot = {
      baseUrl: base,
      orgId: c.env.ORG_ID,
      orgName,
      authMode,
      me: { agentId: me.agentId, name: me.name, email: me.email, role: me.role },
      wsUrl: `${base.replace(/^http/, 'ws')}/ws/host`,
      sites,
      agents: agents.map(summarize)
    }

    return c.html(
      layout(
        `${orgName} · Live`,
        html`
          <div class="shell">
            ${header(orgName, me, authMode)}
            ${realtimeCredentials(c.env) ? '' : credentialsBanner()}
            ${liveTab(metrics, recent)}
            ${embedTab()}
            ${inboxTab()}
            ${clipTab(profile)}
            ${agentsTab(authMode, isAdmin)}
          </div>
          ${mediaModal()}
          <div id="toasts" class="toast-wrap"></div>
          <script type="application/json" id="boot">${raw(JSON.stringify(boot))}</script>
          <script type="module" src="/host/app.js"></script>
        `,
        HOST_STYLES
      )
    )
  })
}

/**
 * A fresh deployment works up to the moment a call is accepted. Rather than
 * fail there, in front of a visitor, say so here, in front of the admin.
 */
function credentialsBanner(): Html {
  return html`<div class="banner" role="status">
    <strong>Calls cannot start yet.</strong> This deployment has no RealtimeKit credentials. Add the
    three secrets — <span class="mono">REALTIMEKIT_APP_ID</span>, <span class="mono">REALTIMEKIT_API_TOKEN</span>,
    <span class="mono">CLOUDFLARE_ACCOUNT_ID</span> — as the README's “RealtimeKit” section describes, then
    reload. Everything else on this page works.
  </div>`
}

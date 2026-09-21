/** The dashboard header: org status, the tab strip, and the agent's controls. */

import { html } from 'hono/html'
import type { AgentSession } from '../../../lib/auth'
import type { Html } from '../layout'

export function header(orgName: string, me: AgentSession, authMode: 'password' | 'access'): Html {
  const isAdmin = me.role === 'admin'
  return html`<header class="top">
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
      <button id="btn-check" class="btn-ghost" type="button">Audio &amp; video settings</button>
      <button id="btn-pause" class="btn-ghost hidden" type="button">Pause new requests</button>
      <button id="btn-live" class="btn-live" type="button" disabled>Go live</button>
      ${authMode === 'access' ? '' : html`<form method="post" action="/host/logout"><button class="btn-ghost" type="submit">Sign out</button></form>`}
    </div>
  </header>

  <p id="live-region" class="hidden" role="status" aria-live="polite"></p>

  <!-- Browsers refuse to play sound until you have clicked something on
       the page. After a reload you may not have, so a join that arrives
       first cannot ring — this says so, and any click fixes it. -->
  <div id="sound-locked" class="banner hidden" role="status">
    <strong>Someone is waiting</strong> — click anywhere to turn on the alert sound.
  </div>`
}

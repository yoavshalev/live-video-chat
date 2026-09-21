/**
 * The Live tab: today's numbers, your own call (or the idle status), and the
 * sidebar — the queue with each visitor's site, the other agents, and today's
 * activity. Everything that moves is hydrated over the socket.
 */

import { html } from 'hono/html'
import type { RecentSession, TodayMetrics } from '../../../lib/db'
import type { Html } from '../layout'

export function liveTab(metrics: TodayMetrics, recent: RecentSession[]): Html {
  return html`<section id="tab-live" class="tab-panel" role="tabpanel">
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
  </section>`
}

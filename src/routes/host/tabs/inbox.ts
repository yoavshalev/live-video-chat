/** The Inbox tab: every join request and offline message, filled by the client. */

import { html } from 'hono/html'
import type { Html } from '../layout'

export function inboxTab(): Html {
  return html`<section id="tab-inbox" class="tab-panel hidden" role="tabpanel">
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
  </section>`
}

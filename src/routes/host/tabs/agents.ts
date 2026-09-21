/** The Agents tab: your own sign-in, adding colleagues (admins), and the team list the client fills. */

import { html } from 'hono/html'
import type { Html } from '../layout'

export function agentsTab(authMode: 'password' | 'access', isAdmin: boolean): Html {
  return html`<section id="tab-agents" class="tab-panel hidden" role="tabpanel">
    <div class="embed-grid">
      <div class="stack">
        ${authMode === 'access'
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
                ${authMode === 'access'
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
  </section>`
}

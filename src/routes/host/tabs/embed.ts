/** The Embed tab (admins): how domains work, add a site, and the site cards the client fills. */

import { html } from 'hono/html'
import type { Html } from '../layout'

export function embedTab(): Html {
  return html`<section id="tab-embed" class="tab-panel hidden" role="tabpanel">
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
  </section>`
}

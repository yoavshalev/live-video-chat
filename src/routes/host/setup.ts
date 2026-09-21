/**
 * First-run setup: the page a fresh deployment shows until it has an admin.
 *
 * A one-click deploy has no terminal to run scripts/agent.mjs from, so the
 * first admin is created here instead. The page exists only while the agents
 * table is empty. The insert is guarded in SQL, so two people racing for a
 * brand-new deployment cannot both win, and once anyone has, every later visit
 * is a redirect to sign-in. Do it right after deploying: until then the URL is
 * open to whoever finds it first, as with any fresh install.
 *
 * Access mode never needs it — the first Access user becomes the admin.
 */

import type { Hono } from 'hono'
import { html } from 'hono/html'
import type { AppEnv } from '../../types'
import { createAgentSession, sessionSecretProblem } from '../../lib/auth'
import { hashPassword, passwordProblem } from '../../lib/password'
import { countAgents, createFirstAdmin } from '../../lib/db'
import { consume } from '../../lib/ratelimit'
import { clientIp, hashIp } from '../../lib/security'
import { layout, type Html } from './layout'

interface Draft {
  name: string
  email: string
}

export function registerSetup(app: Hono<AppEnv>): void {
  app.get('/setup', async (c) => {
    if (c.env.HOST_AUTH_MODE === 'access') return c.redirect('/host')
    if ((await countAgents(c.env)) > 0) return c.redirect('/host/login')
    return c.html(page(sessionSecretProblem(c.env, c.req.raw), { name: '', email: '' }))
  })

  app.post('/setup', async (c) => {
    if (c.env.HOST_AUTH_MODE === 'access') return c.redirect('/host')
    if ((await countAgents(c.env)) > 0) return c.redirect('/host/login')

    const form = await c.req.formData()
    const draft: Draft = { name: String(form.get('name') ?? ''), email: String(form.get('email') ?? '') }
    const password = String(form.get('password') ?? '')

    // Same budget as sign-in: this is a page that accepts a password.
    const identity = await hashIp(clientIp(c.req.raw), c.env.ORG_ID)
    const verdict = await consume(c.env, 'hostLogin', identity)
    if (!verdict.allowed) return c.html(page('Too many attempts. Wait a few minutes.', draft), 429)

    // Checked before creating anybody: an admin who exists but cannot sign in
    // is worse than no admin, because this page would then be gone.
    const secretProblem = sessionSecretProblem(c.env, c.req.raw)
    if (secretProblem) return c.html(page(secretProblem, draft), 503)

    const problem = passwordProblem(password)
    if (problem) return c.html(page(problem, draft), 400)

    const result = await createFirstAdmin(c.env, { ...draft, passwordHash: await hashPassword(password) })
    if (!result.ok) {
      if (result.status === 409) return c.redirect('/host/login')
      return c.html(page(result.reason, draft), result.status)
    }
    await createAgentSession(c, result.agent)
    return c.redirect('/host')
  })
}

function page(error: string | null, draft: Draft): Html {
  return layout(
    'Set up',
    html`<div style="display:grid;place-items:center;min-height:100vh;padding:20px">
      <form method="post" action="/setup" class="card stack" style="width:100%;max-width:400px">
        <div>
          <h1>Live video chat</h1>
          <p class="muted small" style="margin:6px 0 0">
            This deployment has no admin yet. Create the first one — you. This page disappears afterwards.
          </p>
        </div>
        ${error ? html`<div class="small" role="alert" style="color:var(--danger)">${error}</div>` : ''}
        <div>
          <label for="name">Your name</label>
          <input id="name" name="name" type="text" autocomplete="name" maxlength="60" value="${draft.name}" autofocus required />
        </div>
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" maxlength="120" value="${draft.email}" required />
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required />
          <p class="tiny muted" style="margin:6px 0 0">At least 12 characters.</p>
        </div>
        <button class="btn-primary" type="submit">Create admin and sign in</button>
        <p class="tiny muted" style="margin:0">
          Colleagues are added on the Agents tab once you are in. Calls need the RealtimeKit
          secrets described in the README; the dashboard will say so until they are set.
        </p>
      </form>
    </div>`
  )
}

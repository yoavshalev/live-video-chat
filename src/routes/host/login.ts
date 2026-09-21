/**
 * Sign in and out (password mode), and the dashboard's client bundle.
 *
 * In `access` mode Cloudflare Access handles sign-in in front of the Worker and
 * the login page is never reached, so it redirects rather than offering a
 * second, weaker way in.
 */

import type { Hono } from 'hono'
import { html } from 'hono/html'
import type { AppEnv } from '../../types'
import { authenticatePassword, clearAgentSession, createAgentSession, requireAgent } from '../../lib/auth'
import { consume } from '../../lib/ratelimit'
import { clientIp, hashIp } from '../../lib/security'
import hostAppSource from '../../generated/host.js'
import { layout } from './layout'

export function registerLogin(app: Hono<AppEnv>): void {
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

  app.get('/host/app.js', requireAgent(), (c) =>
    c.body(hostAppSource, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'private, max-age=60'
    })
  )
}

/**
 * Agent management and your own password.
 *
 * Anyone can see the team. Only admins change it, and the last enabled admin
 * can be neither demoted nor disabled — an organization with no admin is one
 * nobody can fix from the dashboard.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { requireAgent } from '../../lib/auth'
import { hashPassword, passwordProblem, verifyPassword } from '../../lib/password'
import { countEnabledAdmins, createAgent, getAgentById, listAgents, summarize, updateAgent } from '../../lib/db'

export function registerAgents(app: Hono<AppEnv>): void {
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
}

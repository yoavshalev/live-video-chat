/** Site management: create, domains, per-site settings. Admins only for writes. */

import type { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { requireAgent } from '../../lib/auth'
import { addDomain, createSite, listSites, removeDomain, updateSiteSettings } from '../../lib/sites'

export function registerSites(app: Hono<AppEnv>): void {
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
}

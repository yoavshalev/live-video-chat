/** Read-only dashboard APIs: today's numbers, activity, the inbox, diagnostics. */

import type { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { requireAgent } from '../../lib/auth'
import { getTodayMetrics, listInbox, listOfflineMessages, recentSessions, startOfTodayUtc } from '../../lib/db'
import { room } from '../../lib/room'
import { listPresets, realtimeCredentials } from '../../lib/realtimekit'

export function registerReads(app: Hono<AppEnv>): void {
  app.get('/api/host/metrics', requireAgent(), async (c) => c.json(await getTodayMetrics(c.env)))
  app.get('/api/host/recent', requireAgent(), async (c) => c.json({ sessions: await recentSessions(c.env, startOfTodayUtc()) }))
  app.get('/api/host/messages', requireAgent(), async (c) => c.json({ messages: await listOfflineMessages(c.env, 50) }))
  app.get('/api/host/inbox', requireAgent(), async (c) => c.json({ items: await listInbox(c.env, 100) }))
  app.get('/api/host/room', requireAgent(), async (c) => c.json(await room(c.env).debugState()))

  /**
   * What RealtimeKit thinks this app looks like. The preset names here are the
   * ones REALTIMEKIT_HOST_PRESET / REALTIMEKIT_VISITOR_PRESET must match — they
   * vary by how the app was created, and a mismatch is invisible until the first
   * accepted call fails.
   */
  app.get('/api/host/realtimekit', requireAgent(), async (c) => {
    if (!realtimeCredentials(c.env)) {
      return c.json({ configured: false, presets: [], note: 'Set CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN.' })
    }
    try {
      const presets = await listPresets(c.env)
      return c.json({
        configured: true,
        presets,
        using: { host: c.env.REALTIMEKIT_HOST_PRESET, visitor: c.env.REALTIMEKIT_VISITOR_PRESET },
        ok: presets.includes(c.env.REALTIMEKIT_HOST_PRESET) && presets.includes(c.env.REALTIMEKIT_VISITOR_PRESET)
      })
    } catch (error) {
      return c.json({ configured: true, error: error instanceof Error ? error.message : String(error) }, 502)
    }
  })
}

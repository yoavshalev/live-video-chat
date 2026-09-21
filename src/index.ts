/**
 * Worker entry point.
 *
 * Shape of the system, in one place:
 *
 *   widget.js on any site ──ws──┐
 *   host dashboard ────────ws───┼──▶ LiveHostRoom (one Durable Object)
 *   waiting visitors ──────ws───┘        │
 *                                        ├─▶ D1     history, metrics, messages
 *                                        ├─▶ KV     rate-limit windows
 *                                        └─▶ RealtimeKit REST (only on accept)
 *
 *   /call (same-origin iframe) ──▶ RealtimeKit WebRTC, peer-to-Cloudflare
 *
 * No media byte passes through this Worker or the Durable Object. They carry
 * presence, queue order and credentials; the conversation itself is WebRTC to
 * Cloudflare's edge.
 *
 * Route registration order matters only in that /* catch-alls come last.
 */

import { Hono } from 'hono'
import type { AppEnv } from './types'
import { agentIdentity } from './lib/auth'

import * as health from './routes/health'
import * as widget from './routes/widget'
import * as ws from './routes/ws'
import * as api from './routes/api'
import * as media from './routes/media'
import * as sdk from './routes/sdk'
import * as call from './routes/call'
import * as host from './routes/host'

export { LiveHostRoom } from './durable/LiveHostRoom'

const app = new Hono<AppEnv>()

// Resolves the agent identity for every request without rejecting anything, so
// routes can ask "is this an agent?" without each one re-implementing auth.
// Cookie signature only — no database on this path.
app.use('*', agentIdentity())

// Nothing here should ever be indexed: it is a control plane and a set of
// endpoints for other people's pages.
//
// A 101 upgrade is skipped deliberately — its headers are immutable, and trying
// to touch them throws, which turns every WebSocket connection into a 500.
app.use('*', async (c, next) => {
  await next()
  if (c.res.status === 101 || c.res.webSocket) return
  if (c.res.headers.has('X-Robots-Tag')) return
  try {
    c.res.headers.set('X-Robots-Tag', 'noindex, nofollow')
  } catch {
    // A response handed back by the Cache API has immutable headers, and setting
    // one throws. Rebuilding it is cheap (the body is a stream, not a copy) and
    // beats a 500 on a static asset for the sake of a robots hint.
    const mutable = new Response(c.res.body, c.res)
    mutable.headers.set('X-Robots-Tag', 'noindex, nofollow')
    c.res = mutable
  }
})

health.register(app)
widget.register(app)
ws.register(app)
api.register(app)
media.register(app)
sdk.register(app)
call.register(app)
host.register(app)

app.notFound((c) => c.json({ error: 'not found' }, 404))

app.onError((error, c) => {
  console.error('[worker]', error instanceof Error ? error.stack ?? error.message : String(error))
  return c.json({ error: 'internal error' }, 500)
})

export default app

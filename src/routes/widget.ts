/**
 * Delivery of the embeddable script.
 *
 * `widget.js` is completely static — it contains no host presence, no site
 * config, not even the base URL (it derives that from its own `script.src`).
 * That is what lets it be cached hard at the edge and in the browser while
 * presence still changes in seconds: the dynamic half arrives over
 * /embed/config and the WebSocket, never baked into the asset.
 *
 * Versioned copies are served from /widget/v1.js so an embedding site can pin
 * one if it ever needs to; /widget.js is the rolling pointer that everything
 * uses by default.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../types'
// Imported as text via the `Text` module rule in wrangler.jsonc. Built from
// client/widget/index.ts by `npm run build:client`.
import widgetSource from '../generated/widget.js'

/**
 * An hour. Long enough that repeat visitors never re-download it, short enough
 * that a fix reaches every embedding site the same afternoon without anyone
 * editing their HTML. `stale-while-revalidate` means even the miss is instant.
 */
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400'

function scriptResponse(body: string, etag: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
      // The script is meant to be loaded from other origins — that is its entire
      // purpose — but it is never a document and never framed.
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

/** Cheap, stable identity for the bundle so conditional requests get a 304. */
function etagOf(body: string): string {
  let hash = 2166136261
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `W/"${(hash >>> 0).toString(36)}-${body.length.toString(36)}"`
}

export function register(app: Hono<AppEnv>): void {
  const etag = etagOf(widgetSource)

  const serve = (c: Context<AppEnv>) => {
    if (c.req.header('If-None-Match') === etag) {
      return c.body(null, 304, { ETag: etag, 'Cache-Control': CACHE_CONTROL })
    }
    return scriptResponse(widgetSource, etag)
  }

  app.get('/widget.js', serve)
  app.get('/widget/v1.js', serve)
}

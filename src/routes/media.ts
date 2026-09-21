/**
 * R2-backed media: the looping intro clip, its poster, and the host avatar.
 *
 * Served through this Worker rather than a public bucket URL for two reasons.
 * An embedding site's CSP then needs exactly one entry (`live.example.com`)
 * instead of one per storage host, and range requests — which is how every
 * browser actually plays a video — are handled correctly and cached.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { requireAgent } from '../lib/auth'
import { updateHostProfile } from '../lib/db'
import { room } from '../lib/room'

/** Immutable by convention: uploads are written under a fresh key every time. */
const CACHE_CONTROL = 'public, max-age=604800, immutable'

const ALLOWED_UPLOAD_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/webp'
])
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Explicit, so the R2 key never inherits a codec string from the media type. */
const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

export function register(app: Hono<AppEnv>): void {
  /**
   * GET /media/<key>
   *
   * Range support is not optional here. Safari in particular issues a
   * `Range: bytes=0-1` probe before it will play anything, and a server that
   * answers 200 with the whole body makes the clip simply not start.
   */
  app.get('/media/*', async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^\/media\//, ''))
    if (!key || key.includes('..')) return c.text('not found', 404)

    const range = c.req.header('Range')
    const object = await c.env.MEDIA.get(key, range ? { range: c.req.raw.headers } : undefined)
    if (!object) return c.text('not found', 404)

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('ETag', object.httpEtag)
    headers.set('Cache-Control', CACHE_CONTROL)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('X-Content-Type-Options', 'nosniff')
    // The clip is displayed by widgets on other origins.
    headers.set('Access-Control-Allow-Origin', '*')

    if (object.range && 'offset' in object.range) {
      const offset = object.range.offset ?? 0
      const length = object.range.length ?? object.size - offset
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      return new Response(object.body, { status: 206, headers })
    }
    return new Response(object.body, { headers })
  })

  /**
   * Replaces the looping clip or its poster from the dashboard.
   *
   * A new key per upload (rather than overwriting one) is what makes the
   * immutable cache header above honest — the old clip keeps working in caches
   * and tabs that already have it, and the new one is never a stale hit.
   */
  app.post('/host/media/:kind', requireAgent(), async (c) => {
    const kind = c.req.param('kind')
    if (kind !== 'loop' && kind !== 'poster' && kind !== 'avatar') {
      return c.json({ error: 'unknown media kind' }, 400)
    }

    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return c.json({ error: 'no file' }, 400)
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (25MB max)' }, 413)

    // Browser recordings arrive as "video/webm;codecs=vp8,opus" — the parameters
    // are not part of the media type and must not reach the allow-list check or
    // the file extension.
    const contentType = (file.type.split(';')[0] ?? '').trim().toLowerCase()
    if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
      return c.json({ error: `unsupported type ${contentType || 'unknown'}` }, 415)
    }
    if (kind === 'loop' && !contentType.startsWith('video/')) {
      return c.json({ error: 'the loop must be a video' }, 415)
    }
    if (kind !== 'loop' && !contentType.startsWith('image/')) {
      return c.json({ error: 'that must be an image' }, 415)
    }

    const extension = EXTENSIONS[contentType] ?? 'bin'
    const key = `${c.env.ORG_ID}/${kind}-${Date.now()}.${extension}`
    await c.env.MEDIA.put(key, file.stream(), {
      httpMetadata: { contentType, cacheControl: CACHE_CONTROL }
    })

    const url = `${c.env.PUBLIC_BASE_URL}/media/${key}`
    await updateHostProfile(c.env, c.env.ORG_ID, {
      ...(kind === 'loop' ? { loopVideoUrl: url } : {}),
      ...(kind === 'poster' ? { loopPosterUrl: url } : {}),
      ...(kind === 'avatar' ? { avatarUrl: url } : {})
    })
    // Widgets hold the profile from their HELLO; without this they would keep
    // playing the old clip until every visitor happened to reload.
    await room(c.env).invalidateProfile()

    return c.json({ ok: true, url })
  })
}

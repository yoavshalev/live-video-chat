/**
 * Refuses state-changing requests that a browser reports as coming from
 * another site. The session cookie is SameSite=Lax, which already keeps it off
 * cross-site POSTs; this closes the remaining gaps (same-site subdomains, older
 * browsers, a future GET that mutates) without a token to thread through every
 * form and fetch.
 *
 * A request with neither header is not from a browser (curl, the smoke suites)
 * and cannot be carrying a victim's cookie, so it passes.
 */

import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'
import { publicBaseUrl } from './base-url'

export function rejectCrossSiteWrites(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const fetchSite = c.req.header('Sec-Fetch-Site')
    const origin = c.req.header('Origin')
    // "Ours" is the origin this request was addressed to, and the configured
    // public one if there is one. Both, because `wrangler dev` rewrites a local
    // browser's Origin to the configured route host while PUBLIC_BASE_URL still
    // says localhost — and in production the two are simply the same string.
    const ours = new Set([new URL(c.req.url).origin, new URL(publicBaseUrl(c.env, c.req.raw)).origin])
    const crossSite = (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') || (origin && !ours.has(origin))
    if (crossSite) {
      console.warn('[auth] refused cross-site write', { method, path: c.req.path, fetchSite, origin, ours: [...ours] })
      return c.json({ error: 'cross-site request refused' }, 403)
    }
    await next()
  }
}

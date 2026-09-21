/**
 * First-party delivery of the RealtimeKit browser SDK.
 *
 * The SDK is a ~150KB public npm bundle that Cloudflare publishes to jsDelivr. We
 * re-serve it from our own origin instead of pointing at the CDN so that the
 * call page has a single script origin: one CSP entry, no third-party connection
 * from a page that is about to ask for camera and microphone access, and no
 * dependency on a CDN an embedding site's CSP may block outright.
 *
 * The version is pinned. `@latest` on a WebRTC SDK means a silent upgrade can
 * break calls on a Tuesday with no deploy of ours to correlate it with.
 *
 * ROUTING: the path is registered as a LITERAL, built from the version constant.
 * It was once `/sdk/realtimekit-:version.js`, which never matched anything —
 * Hono does not bind a `:param` that is followed by a literal suffix inside the
 * same path segment, so every request 404'd and every call failed at "Could not
 * load the video SDK". A literal route cannot fail that way, and bumping the
 * version moves the route and the cache key together, which is what we want.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../types'

const SDK_VERSION = '2.0.2'
const UPSTREAM = `https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@${SDK_VERSION}/dist/browser.js`

/**
 * Bumped when a deploy must escape browser caches, independently of the SDK
 * version.
 *
 * r2 exists because r1 briefly served a 500 carrying `Cache-Control: immutable,
 * max-age=31536000`. Any browser that hit it during that window would never
 * re-request the URL — for a year — and every call from that browser would fail
 * at "Could not load the video SDK" with no way to recover. Changing the path is
 * the only thing that reaches a cache entry like that.
 */
const PATH_REVISION = 'r2'

export const SDK_PATH = `/sdk/realtimekit-${SDK_VERSION}-${PATH_REVISION}.js`

export function register(app: Hono<AppEnv>): void {
  app.get(SDK_PATH, async (c) => {
    // `cacheEverything` puts the upstream bundle in the edge cache keyed by its
    // jsDelivr URL, so cold starts are the only fetches that leave Cloudflare.
    //
    // There was a second layer here using the Cache API. It was removed: a
    // response returned straight from `caches.default` has IMMUTABLE headers, so
    // every cache hit then blew up in the global header middleware and served a
    // 500 — while the browser cached that 500 for a year, because the immutable
    // Cache-Control had already been set. One caching mechanism is enough.
    const upstream = await fetch(UPSTREAM, { cf: { cacheTtl: 86400, cacheEverything: true } })
    if (!upstream.ok) {
      console.error('[sdk] upstream fetch failed', upstream.status, UPSTREAM)
      return c.text(`could not fetch the RealtimeKit SDK (${upstream.status})`, 502)
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  /**
   * Any other version. A page cached from before a version bump will ask for the
   * old path; saying so beats the generic JSON 404, which is indistinguishable
   * from the route being broken — as it in fact was.
   */
  app.get('/sdk/*', (c) =>
    c.text(`unknown SDK version — this deployment serves ${SDK_PATH}`, 404, {
      'Cache-Control': 'no-store'
    })
  )
}

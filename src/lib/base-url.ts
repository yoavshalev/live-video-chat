/**
 * Where this deployment lives, as seen from outside.
 *
 * Set PUBLIC_BASE_URL when you want one answer regardless of how a request
 * arrived (a Worker reachable on both workers.dev and a custom domain, a local
 * dev server behind a tunnel). Leave it unset and the answer is the origin the
 * request was addressed to — which is what lets the template deploy untouched:
 * a one-click deploy lands on a workers.dev hostname nobody knew in advance.
 *
 * The value is baked into the widget's socket URL, the call iframe, the embed
 * snippet and the session cookie's flags, so every caller goes through here.
 */

import type { Env } from '../types'

export function publicBaseUrl(env: Env, request: Request): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  return new URL(request.url).origin
}

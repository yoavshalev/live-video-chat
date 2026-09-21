/**
 * Site configuration and origin enforcement.
 *
 * THE SECURITY BOUNDARY: `siteId` arrives from a script tag on a page we do not
 * control, so it is a claim, not a fact. The only thing that makes it meaningful
 * is checking the browser-supplied `Origin` header against domains we configured.
 * Everything that spends resources on a visitor's behalf — opening a socket,
 * joining the queue, minting media credentials — goes through `resolveSite`.
 *
 * A site holds ROOT DOMAINS. Each covers itself and every subdomain, over https
 * only (localhost excepted). The matching itself lives in src/shared/domains.ts
 * because it is the part that has to be right, and that file has the tests.
 */

import type { Env, SiteRow } from '../types'
import { normalizeDomain, originAllowed } from '../shared/domains'

export interface SiteConfig {
  id: string
  name: string
  /** Root domains; see src/shared/domains.ts for what one admits. */
  allowedDomains: string[]
  theme: 'dark' | 'light' | 'auto'
  position: 'bottom-right' | 'bottom-left'
  accentColor: string | null
  customGreeting: string | null
  enabled: boolean
  /** What the widget does while the host is offline. */
  offlineMode: 'show' | 'hide'
  /** The name in the widget's copy — "<label> is live". Null → "Agent". */
  agentLabel: string | null
}

/** What the widget shows when no label is set: neutral, never the host's own name. */
export const DEFAULT_AGENT_LABEL = 'Agent'

/**
 * Per-isolate cache. widget.js is requested on every page view of every embedding
 * site; a D1 round trip for each would be pure waste. 60s means a config change
 * takes at most a minute to reach every edge, which is the right trade for data
 * that changes a few times a year — and is why the dashboard says "within a
 * minute" after you add a domain.
 */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: SiteConfig | null; expires: number }>()

const SELECT =
  'SELECT id, name, allowed_origins, allowed_domains, theme, position, accent_color, custom_greeting, enabled, created_at, offline_mode, agent_label FROM sites'

function parseList(json: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : []
  } catch {
    // Malformed means NO entries, never "all of them". Failing closed here is the
    // difference between a broken widget and an open one.
    return []
  }
}

function toConfig(row: SiteRow): SiteConfig {
  let domains = parseList(row.allowed_domains)
  if (domains.length === 0) {
    // Pre-migration row: reduce the old exact origins to roots. Runs until the
    // first dashboard edit writes the new column.
    const derived = parseList(row.allowed_origins)
      .map((origin) => normalizeDomain(origin))
      .filter((d): d is string => d !== null)
    domains = [...new Set(derived)]
  }
  return {
    id: row.id,
    name: row.name,
    allowedDomains: domains,
    theme: row.theme,
    position: row.position,
    accentColor: row.accent_color,
    customGreeting: row.custom_greeting,
    enabled: row.enabled === 1,
    offlineMode: row.offline_mode === 'hide' ? 'hide' : 'show',
    agentLabel: row.agent_label && row.agent_label.trim() ? row.agent_label.trim() : null
  }
}

export async function getSite(env: Env, siteId: string): Promise<SiteConfig | null> {
  const cached = cache.get(siteId)
  const now = Date.now()
  if (cached && cached.expires > now) return cached.value

  const row = await env.DB.prepare(`${SELECT} WHERE id = ?`).bind(siteId).first<SiteRow>()
  const value = row ? toConfig(row) : null
  cache.set(siteId, { value, expires: now + CACHE_TTL_MS })
  return value
}

export async function listSites(env: Env): Promise<SiteConfig[]> {
  const result = await env.DB.prepare(`${SELECT} ORDER BY name`).all<SiteRow>()
  return (result.results ?? []).map(toConfig)
}

export type SiteResolution =
  | { ok: true; site: SiteConfig; origin: string }
  | { ok: false; status: 400 | 403 | 404; reason: string }

/**
 * The one function every visitor-facing entry point calls first.
 *
 * A missing Origin header is allowed only for same-origin requests to our own
 * host (the call page, the dashboard's own fetches). Cross-origin requests from a
 * browser always carry Origin, so its absence on an embed request means the
 * caller is not a browser doing what we designed for.
 */
export async function resolveSite(env: Env, siteId: string | null, request: Request): Promise<SiteResolution> {
  if (!siteId) return { ok: false, status: 400, reason: 'missing siteId' }

  const site = await getSite(env, siteId)
  if (!site) return { ok: false, status: 404, reason: 'unknown site' }
  if (!site.enabled) return { ok: false, status: 403, reason: 'site disabled' }

  const origin = request.headers.get('Origin')
  if (!origin) {
    const selfOrigin = new URL(env.PUBLIC_BASE_URL).origin
    const referer = request.headers.get('Referer')
    if (referer && referer.startsWith(selfOrigin)) return { ok: true, site, origin: selfOrigin }
    return { ok: false, status: 403, reason: 'missing origin' }
  }

  if (!originAllowed(origin, site.allowedDomains)) {
    return { ok: false, status: 403, reason: 'origin not allowed for this site' }
  }
  return { ok: true, site, origin }
}

/**
 * CORS for an already-validated origin. Deliberately echoes the exact origin we
 * matched rather than `*`, so a permissive header can never outlive the check
 * that produced it.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
}

/**
 * CSP `frame-ancestors` sources for a set of root domains: the apex plus a
 * wildcard for subdomains, https only, with localhost allowed on any port.
 * Mirrors originAllowed() exactly — if the two ever disagree, the call page
 * either refuses to frame on a site the widget works on, or the reverse.
 */
export function frameAncestorsFor(domains: readonly string[]): string[] {
  const sources: string[] = []
  for (const domain of domains) {
    if (domain === 'localhost' || domain === '127.0.0.1') {
      sources.push(`http://${domain}:*`)
      continue
    }
    sources.push(`https://${domain}`, `https://*.${domain}`)
  }
  return sources
}

export function invalidateSiteCache(siteId?: string): void {
  if (siteId) cache.delete(siteId)
  else cache.clear()
}

// ─── Mutations (dashboard only) ──────────────────────────────────────────────

export type SiteMutation =
  | { ok: true; site: SiteConfig }
  | { ok: false; status: 400 | 404 | 409; reason: string }

const SITE_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export async function createSite(env: Env, input: { id: string; name: string }): Promise<SiteMutation> {
  const id = input.id.trim().toLowerCase()
  const name = input.name.trim().slice(0, 60)
  if (!SITE_ID.test(id)) {
    return { ok: false, status: 400, reason: 'Site id must be 3–40 characters: lowercase letters, digits and hyphens.' }
  }
  if (!name) return { ok: false, status: 400, reason: 'Give the site a name.' }
  if (await getSite(env, id)) return { ok: false, status: 409, reason: `A site called "${id}" already exists.` }

  await env.DB.prepare(
    `INSERT INTO sites (id, name, allowed_origins, allowed_domains, theme, position, accent_color, custom_greeting, enabled, created_at)
     VALUES (?, ?, '[]', '[]', 'auto', 'bottom-right', NULL, NULL, 1, ?)`
  )
    .bind(id, name, Date.now())
    .run()
  invalidateSiteCache(id)
  const site = await getSite(env, id)
  return site ? { ok: true, site } : { ok: false, status: 404, reason: 'not found after insert' }
}

async function writeDomains(env: Env, site: SiteConfig, domains: string[]): Promise<SiteMutation> {
  await env.DB.prepare('UPDATE sites SET allowed_domains = ? WHERE id = ?')
    .bind(JSON.stringify(domains), site.id)
    .run()
  invalidateSiteCache(site.id)
  const fresh = await getSite(env, site.id)
  return fresh ? { ok: true, site: fresh } : { ok: false, status: 404, reason: 'not found' }
}

export async function addDomain(env: Env, siteId: string, raw: string): Promise<SiteMutation> {
  const site = await getSite(env, siteId)
  if (!site) return { ok: false, status: 404, reason: 'unknown site' }

  const domain = normalizeDomain(raw)
  if (!domain) {
    return {
      ok: false,
      status: 400,
      reason: 'That is not a usable domain. Enter a root like example.com — it covers every subdomain.'
    }
  }
  if (site.allowedDomains.includes(domain)) return { ok: true, site }
  // Written as the full current list so a pre-migration row is converted in the
  // same step, rather than appending to a column the fallback was ignoring.
  return writeDomains(env, site, [...site.allowedDomains, domain])
}

export async function removeDomain(env: Env, siteId: string, domain: string): Promise<SiteMutation> {
  const site = await getSite(env, siteId)
  if (!site) return { ok: false, status: 404, reason: 'unknown site' }
  return writeDomains(
    env,
    site,
    site.allowedDomains.filter((existing) => existing !== domain)
  )
}

export interface SiteSettingsPatch {
  enabled?: boolean
  offlineMode?: 'show' | 'hide'
  /** Empty string clears it back to the default. */
  agentLabel?: string
}

export async function updateSiteSettings(env: Env, siteId: string, patch: SiteSettingsPatch): Promise<SiteMutation> {
  const site = await getSite(env, siteId)
  if (!site) return { ok: false, status: 404, reason: 'unknown site' }

  const sets: string[] = []
  const values: unknown[] = []
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (patch.offlineMode !== undefined) {
    sets.push('offline_mode = ?')
    values.push(patch.offlineMode)
  }
  if (patch.agentLabel !== undefined) {
    // Visitor-facing text, so it gets the same treatment as visitor-supplied
    // text: no markup, no control characters, a hard cap.
    const label = patch.agentLabel.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    sets.push('agent_label = ?')
    values.push(label.length > 0 ? label : null)
  }
  if (sets.length === 0) return { ok: true, site }

  values.push(siteId)
  await env.DB.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run()
  invalidateSiteCache(siteId)
  const fresh = await getSite(env, siteId)
  return fresh ? { ok: true, site: fresh } : { ok: false, status: 404, reason: 'not found' }
}

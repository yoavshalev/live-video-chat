/**
 * Agent authentication. The dashboard is the control plane for every embedded
 * widget, so "only our agents" is the requirement, and an unguessable URL is not
 * authentication.
 *
 * Two modes, chosen by HOST_AUTH_MODE:
 *
 *   password — Each agent has an email and a PBKDF2 password hash in the agents
 *              table (src/lib/password.ts; created with scripts/agent.mjs or by
 *              an admin on the dashboard). A successful login is a signed,
 *              HttpOnly cookie. Rate-limited to 8 attempts per IP per 15 minutes.
 *
 *   access   — Cloudflare Access sits in front of the hostname and this code
 *              verifies the JWT it injects, then maps the verified email to an
 *              agent row. Preferred in production: the identity provider, MFA
 *              and session lifetime are Cloudflare's problem, and
 *              unauthenticated requests never reach the Worker at all. An email
 *              Access lets through that has no agent row yet is provisioned as a
 *              plain agent — Access already decided they belong here.
 *
 * In `access` mode the JWT is verified here rather than trusted on sight. The
 * `Cf-Access-Jwt-Assertion` header is only meaningful if Access is genuinely in
 * front of every route to this Worker; verifying the signature, audience and
 * expiry means a misrouted request or a direct hit on an unprotected hostname
 * cannot forge a session by setting a header.
 *
 * COST: the middleware on every request only checks the cookie signature — no
 * database. Routes that matter (the dashboard, the socket upgrade, anything
 * that mutates) go through `requireAgent()`, which also confirms the agent still
 * exists and is enabled. So disabling an agent takes effect on their next page
 * load or reconnect, while widget.js requests never touch D1 for auth.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Env } from '../types'
import type { AgentRole } from '../shared/protocol'
import { base64urlDecode, signSession, verifySession } from './security'
import { verifyPassword } from './password'
import { createAgent, getAgentByEmail, getAgentById, countAgents, touchAgentLogin, type AgentRecord } from './db'

export const SESSION_COOKIE = 'fl_agent'
const SESSION_TTL_SECONDS = 60 * 60 * 12

/** The values published in .dev.vars.example and seed/dev-agent.sql. Local only. */
const DEV_SESSION_SECRET = 'dev-only-not-a-real-secret'
const DEV_ADMIN_EMAIL = 'dev@example.com'

function isLocalDeployment(env: Env): boolean {
  const host = new URL(env.PUBLIC_BASE_URL).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/** What a request knows about the signed-in agent. Cheap to derive; no D1. */
export interface AgentSession {
  agentId: string
  name: string
  email: string
  role: AgentRole
}

interface SessionPayload extends AgentSession {
  exp: number
}

// ─── Password mode ───────────────────────────────────────────────────────────

export async function createAgentSession(c: Context<AppEnv>, agent: AgentRecord): Promise<void> {
  const secret = c.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET is not set')
  const payload: SessionPayload = {
    agentId: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  }
  const token = await signSession(payload as unknown as Record<string, unknown>, secret)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: the dashboard is opened from bookmarks and links, and a
    // Strict cookie is not sent on those top-level navigations — which looks
    // exactly like being logged out.
    sameSite: 'Lax',
    secure: new URL(c.env.PUBLIC_BASE_URL).protocol === 'https:',
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  })
}

export function clearAgentSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/**
 * Email + password → the agent, or null. Runs the hash even for an unknown
 * email so timing does not reveal which addresses exist.
 */
export async function authenticatePassword(env: Env, email: string, password: string): Promise<AgentRecord | null> {
  const agent = await getAgentByEmail(env, email.trim().toLowerCase())
  const ok = await verifyPassword(agent?.password_hash ?? 'pbkdf2$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password)
  if (!agent || !ok || agent.enabled !== 1) return null
  if (agent.email === DEV_ADMIN_EMAIL && !isLocalDeployment(env)) {
    // seed/dev-agent.sql is public. It is for `npm run dev`, and a deployment
    // that loaded it must not accept a password anyone can read on GitHub.
    console.error('[auth] refusing the seeded dev admin outside localhost; disable it and create a real agent with scripts/agent.mjs')
    return null
  }
  void touchAgentLogin(env, agent.id)
  return agent
}

// ─── Cloudflare Access mode ──────────────────────────────────────────────────

interface AccessJwk {
  kid: string
  kty: string
  alg?: string
  use?: string
  n: string
  e: string
}

/**
 * Access rotates signing keys, so the key set is fetched and cached per isolate.
 * 10 minutes is short enough to follow a rotation and long enough that the
 * dashboard's own polling does not fetch certs on every request.
 */
const JWKS_TTL_MS = 10 * 60 * 1000
let jwksCache: { keys: AccessJwk[]; expires: number } | null = null

async function fetchAccessKeys(teamDomain: string): Promise<AccessJwk[]> {
  const now = Date.now()
  if (jwksCache && jwksCache.expires > now) return jwksCache.keys
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 600, cacheEverything: true } })
  if (!response.ok) throw new Error(`Access certs fetch failed: ${response.status}`)
  const body = (await response.json()) as { keys?: AccessJwk[] }
  const keys = body.keys ?? []
  jwksCache = { keys, expires: now + JWKS_TTL_MS }
  return keys
}

interface AccessClaims {
  aud?: string | string[]
  email?: string
  exp?: number
  iss?: string
}

/**
 * Verifies an Access JWT: RS256 signature against the team's published keys,
 * audience equal to this application's AUD tag, issuer equal to the team domain,
 * and not expired.
 *
 * The audience check is the one that is easy to skip and expensive to skip: every
 * application behind the same Access team is signed by the same keys, so without
 * it a token minted for an unrelated internal app would open this dashboard.
 */
export async function verifyAccessJwt(env: Env, token: string): Promise<string | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
  const expectedAud = env.CF_ACCESS_AUD
  if (!teamDomain || !expectedAud) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { kid?: string; alg?: string }
  let claims: AccessClaims
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerPart))) as { kid?: string; alg?: string }
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as AccessClaims
  } catch {
    return null
  }
  // Pinned to RS256. Accepting whatever `alg` claims is the classic JWT
  // vulnerability — `none` and HMAC-with-the-public-key both live there.
  if (header.alg !== 'RS256' || !header.kid) return null

  const keys = await fetchAccessKeys(teamDomain)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return null

  let valid = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64urlDecode(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`))
  } catch {
    return null
  }
  if (!valid) return null

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!audiences.includes(expectedAud)) return null
  if (claims.iss && claims.iss !== `https://${teamDomain}`) return null
  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null
  if (!claims.email) return null
  return claims.email.toLowerCase()
}

/** Access said this email may be here. Find the agent, or make one. */
async function agentForAccessEmail(env: Env, email: string): Promise<AgentRecord | null> {
  const allowed = (env.ALLOWED_HOST_EMAIL ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  // A second, local gate so an Access policy widened by accident does not
  // silently widen the dashboard. Empty means "trust the Access policy".
  if (allowed.length > 0 && !allowed.includes(email)) return null

  const existing = await getAgentByEmail(env, email)
  if (existing) return existing.enabled === 1 ? existing : null

  // The very first person through the door runs the place.
  const role: AgentRole = (await countAgents(env)) === 0 ? 'admin' : 'agent'
  const local = email.split('@')[0] ?? 'agent'
  const name = local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  const result = await createAgent(env, { name, email, passwordHash: null, role })
  return result.ok ? result.agent : null
}

// ─── Resolution and middleware ───────────────────────────────────────────────

/** The session behind a request, from the cookie or the Access JWT. No D1 in password mode. */
export async function resolveSession(c: Context<AppEnv>): Promise<AgentSession | null> {
  const env = c.env
  if (env.HOST_AUTH_MODE === 'access') {
    const assertion = c.req.header('Cf-Access-Jwt-Assertion') ?? getCookie(c, 'CF_Authorization')
    if (!assertion) return null
    try {
      const email = await verifyAccessJwt(env, assertion)
      if (!email) return null
      const agent = await agentForAccessEmail(env, email)
      return agent ? { agentId: agent.id, name: agent.name, email: agent.email, role: agent.role } : null
    } catch (error) {
      console.error('[auth:access]', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const cookie = getCookie(c, SESSION_COOKIE)
  if (!cookie || !env.SESSION_SECRET) return null
  if (env.SESSION_SECRET === DEV_SESSION_SECRET && !isLocalDeployment(env)) {
    // Anyone can sign a session with the example secret. Better no dashboard
    // than one that is open to whoever read .dev.vars.example.
    console.error('[auth] SESSION_SECRET is the example value; set a real one: wrangler secret put SESSION_SECRET')
    return null
  }
  const session = await verifySession<SessionPayload>(cookie, env.SESSION_SECRET)
  if (!session || typeof session.exp !== 'number' || session.exp <= Date.now()) return null
  if (typeof session.agentId !== 'string' || typeof session.name !== 'string') return null
  return { agentId: session.agentId, name: session.name, email: session.email ?? '', role: session.role === 'admin' ? 'admin' : 'agent' }
}

/** Populates `c.get('agent')` on every request. Does not reject anything. */
export function agentIdentity(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('agent', await resolveSession(c))
    await next()
  }
}

/**
 * Guards a route, and confirms against D1 that the agent still exists and is
 * enabled — so a session cookie outlives a disabled account by at most one page
 * load. HTML requests are redirected to sign-in; API requests get 401.
 */
export function requireAgent(options: { admin?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get('agent') ?? (await resolveSession(c))
    const record = session ? await getAgentById(c.env, session.agentId) : null
    const ok = session && record && record.enabled === 1

    if (!ok) {
      const wantsHtml = (c.req.header('Accept') ?? '').includes('text/html')
      if (wantsHtml && c.env.HOST_AUTH_MODE !== 'access') {
        return c.redirect(`/host/login?next=${encodeURIComponent(c.req.path)}`)
      }
      return c.json({ error: 'unauthorized' }, 401)
    }
    // Role and name come from the row, not the cookie, so a promotion or rename
    // is honoured immediately.
    const fresh: AgentSession = { agentId: record.id, name: record.name, email: record.email, role: record.role }
    if (options.admin && fresh.role !== 'admin') return c.json({ error: 'admins only' }, 403)
    c.set('agent', fresh)
    await next()
  }
}

// ─── Cross-site writes ───────────────────────────────────────────────────────

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
export function rejectCrossSiteWrites(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    const fetchSite = c.req.header('Sec-Fetch-Site')
    const origin = c.req.header('Origin')
    // "Ours" is the origin this request was addressed to, and the configured
    // public one. Both, because `wrangler dev` rewrites a local browser's
    // Origin to the configured route host while PUBLIC_BASE_URL still says
    // localhost — and in production the two are simply the same string.
    const ours = new Set([new URL(c.req.url).origin, new URL(c.env.PUBLIC_BASE_URL).origin])
    const crossSite = (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') || (origin && !ours.has(origin))
    if (crossSite) {
      console.warn('[auth] refused cross-site write', { method, path: c.req.path, fetchSite, origin, ours: [...ours] })
      return c.json({ error: 'cross-site request refused' }, 403)
    }
    await next()
  }
}

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
 *   access   — Cloudflare Access sits in front of the hostname; ./access.ts
 *              verifies the JWT it injects and maps the email to an agent.
 *              Preferred in production: the identity provider, MFA and session
 *              lifetime are Cloudflare's problem, and unauthenticated requests
 *              never reach the Worker at all.
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
import { signSession, verifySession } from './security'
import { verifyPassword } from './password'
import { agentForAccessEmail, verifyAccessJwt } from './access'
import { getAgentByEmail, getAgentById, touchAgentLogin, type AgentRecord } from './db'
import { publicBaseUrl } from './base-url'

export const SESSION_COOKIE = 'fl_agent'
const SESSION_TTL_SECONDS = 60 * 60 * 12

/** The values published in .dev.vars.example and seed/dev-agent.sql. Local only. */
const DEV_SESSION_SECRET = 'dev-only-not-a-real-secret'
const DEV_ADMIN_EMAIL = 'dev@example.com'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * True only for `wrangler dev`. A configured PUBLIC_BASE_URL decides on its own;
 * without one, the host the request arrived on does. A production deployment
 * therefore cannot be talked into its local-only leniencies by a Host header
 * as long as it names its public URL — and one that does not is reachable only
 * on the hostname Cloudflare routed to it anyway.
 */
function isLocalDeployment(env: Env, request: Request): boolean {
  const configured = env.PUBLIC_BASE_URL?.trim()
  return LOOPBACK_HOSTS.has(new URL(configured || request.url).hostname)
}

/**
 * Why the session cookie cannot be signed right now, or null when it can.
 *
 * Local development gets the published example value without setting anything,
 * so `npm run dev` needs no secrets. Anywhere else that value is refused: anyone
 * who has read .dev.vars.example could sign themselves in with it, and no
 * dashboard beats an open one.
 */
export function sessionSecretProblem(env: Env, request: Request): string | null {
  const local = isLocalDeployment(env, request)
  if (!env.SESSION_SECRET) {
    return local ? null : 'SESSION_SECRET is not set on this Worker. Run: npx wrangler secret put SESSION_SECRET'
  }
  if (env.SESSION_SECRET === DEV_SESSION_SECRET && !local) {
    return 'SESSION_SECRET is the example value from .dev.vars.example. Set a real one: npx wrangler secret put SESSION_SECRET'
  }
  return null
}

function sessionSecret(env: Env, request: Request): string | null {
  const problem = sessionSecretProblem(env, request)
  if (problem) {
    console.error('[auth]', problem)
    return null
  }
  return env.SESSION_SECRET || DEV_SESSION_SECRET
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
  const secret = sessionSecret(c.env, c.req.raw)
  if (!secret) throw new Error('cannot sign a session; see the log line above')
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
    secure: publicBaseUrl(c.env, c.req.raw).startsWith('https:'),
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
export async function authenticatePassword(env: Env, email: string, password: string, request: Request): Promise<AgentRecord | null> {
  const agent = await getAgentByEmail(env, email.trim().toLowerCase())
  const ok = await verifyPassword(agent?.password_hash ?? 'pbkdf2$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password)
  if (!agent || !ok || agent.enabled !== 1) return null
  if (agent.email === DEV_ADMIN_EMAIL && !isLocalDeployment(env, request)) {
    // seed/dev-agent.sql is public. It is for `npm run dev`, and a deployment
    // that loaded it must not accept a password anyone can read on GitHub.
    console.error('[auth] refusing the seeded dev admin outside localhost; disable it and create a real agent with scripts/agent.mjs')
    return null
  }
  void touchAgentLogin(env, agent.id)
  return agent
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
  if (!cookie) return null
  const secret = sessionSecret(env, c.req.raw)
  if (!secret) return null
  const session = await verifySession<SessionPayload>(cookie, secret)
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

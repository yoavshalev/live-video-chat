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

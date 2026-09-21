/** Agents: the people who may sign in to the dashboard and take calls. */

import type { AgentRow, Env } from '../../types'
import type { AgentRole } from '../../shared/protocol'
import { randomId } from '../security'
import { safeDb } from './safe'

export type AgentRecord = AgentRow

/** What the dashboard and the API show. Never the hash. */
export interface AgentSummary {
  id: string
  name: string
  email: string
  role: AgentRole
  enabled: boolean
  hasPassword: boolean
  createdAt: number
  lastLoginAt: number | null
}

export function summarize(agent: AgentRecord): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    enabled: agent.enabled === 1,
    hasPassword: agent.password_hash !== null,
    createdAt: agent.created_at,
    lastLoginAt: agent.last_login_at
  }
}

const AGENT_COLUMNS = 'id, name, email, password_hash, role, enabled, created_at, last_login_at'

export async function getAgentById(env: Env, id: string): Promise<AgentRecord | null> {
  return (await env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).bind(id).first<AgentRecord>()) ?? null
}

export async function getAgentByEmail(env: Env, email: string): Promise<AgentRecord | null> {
  return (
    (await env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE email = ?`).bind(normalizeEmail(email)).first<AgentRecord>()) ??
    null
  )
}

export async function listAgents(env: Env): Promise<AgentRecord[]> {
  const result = await env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY created_at, id`).all<AgentRecord>()
  return result.results ?? []
}

export async function countAgents(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first<{ n: number }>()
  return row?.n ?? 0
}

export async function countEnabledAdmins(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE role = 'admin' AND enabled = 1").first<{ n: number }>()
  return row?.n ?? 0
}

export async function touchAgentLogin(env: Env, id: string): Promise<void> {
  await safeDb('touchAgentLogin', () => env.DB.prepare('UPDATE agents SET last_login_at = ? WHERE id = ?').bind(Date.now(), id).run())
}

/** Same rule as scripts/agent.mjs, so an id made either way looks the same. */
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type AgentResult = { ok: true; agent: AgentRecord } | { ok: false; reason: string; status: 400 | 404 | 409 }

export async function createAgent(
  env: Env,
  input: { name: string; email: string; passwordHash: string | null; role: AgentRole }
): Promise<AgentResult> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 60)
  const email = normalizeEmail(input.email).slice(0, 120)
  if (!name) return { ok: false, reason: 'Name is required.', status: 400 }
  if (!EMAIL_SHAPE.test(email)) return { ok: false, reason: 'That does not look like an email address.', status: 400 }
  if (await getAgentByEmail(env, email)) return { ok: false, reason: 'An agent with that email already exists.', status: 409 }

  // Ids are what the round-robin sorts by on ties and what appears in call
  // history, so they are readable slugs of the name; a second "Alex" gets a
  // suffix rather than an error.
  let id = slugify(name)
  if (await getAgentById(env, id)) id = `${id}-${randomId('').slice(-4)}`

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO agents (id, name, email, password_hash, role, enabled, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`
  )
    .bind(id, name, email, input.passwordHash, input.role, now)
    .run()
  return { ok: true, agent: { id, name, email, password_hash: input.passwordHash, role: input.role, enabled: 1, created_at: now, last_login_at: null } }
}

export async function updateAgent(
  env: Env,
  id: string,
  patch: Partial<{ name: string; role: AgentRole; enabled: boolean; passwordHash: string | null }>
): Promise<AgentResult> {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!name) return { ok: false, reason: 'Name is required.', status: 400 }
    sets.push('name = ?')
    values.push(name)
  }
  if (patch.role !== undefined) {
    sets.push('role = ?')
    values.push(patch.role)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (patch.passwordHash !== undefined) {
    sets.push('password_hash = ?')
    values.push(patch.passwordHash)
  }
  if (sets.length > 0) {
    values.push(id)
    await env.DB.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run()
  }
  const agent = await getAgentById(env, id)
  return agent ? { ok: true, agent } : { ok: false, reason: 'unknown agent', status: 404 }
}

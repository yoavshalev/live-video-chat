/**
 * D1 access. Every statement in the app lives here so the schema has exactly one
 * set of callers.
 *
 * The history functions are called from the Durable Object *after* it has
 * already broadcast the corresponding state change. A failed history write must
 * never stop a queue from moving, so callers wrap them in `safeDb` and the worst
 * outcome of a D1 outage is a gap in reporting.
 *
 * The agent functions are the other kind: they are the source of truth for who
 * may sign in, and their callers want the error.
 */

import type { AgentRow, Env, HostRow } from '../types'
import type { DbOp } from '../shared/machine'
import type { AgentRole, HostProfileView } from '../shared/protocol'
import { randomId } from './security'

/** Runs a history write that must never take a state transition down with it. */
export async function safeDb(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    console.error(`[db:${label}]`, error instanceof Error ? error.message : String(error))
  }
}

// ─── Organization profile ────────────────────────────────────────────────────

export async function getHostProfile(env: Env, orgId: string): Promise<HostProfileView | null> {
  const row = await env.DB.prepare(
    'SELECT id, display_name, headline, subheadline, loop_video_url, loop_poster_url, avatar_url, created_at, updated_at FROM hosts WHERE id = ?'
  )
    .bind(orgId)
    .first<HostRow>()
  if (!row) return null
  return {
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    loopVideoUrl: row.loop_video_url,
    loopPosterUrl: row.loop_poster_url,
    headline: row.headline,
    subheadline: row.subheadline
  }
}

/**
 * Upserts, so an organization whose row was never seeded still gets its clip
 * saved the first time someone records one. The display name defaults to the
 * org id and is only ever shown on the dashboard — visitors see the per-site
 * agent label, never this.
 */
export async function updateHostProfile(
  env: Env,
  orgId: string,
  patch: Partial<{
    displayName: string
    headline: string
    subheadline: string
    loopVideoUrl: string | null
    loopPosterUrl: string | null
    avatarUrl: string | null
  }>
): Promise<void> {
  const columns: Record<string, string> = {
    displayName: 'display_name',
    headline: 'headline',
    subheadline: 'subheadline',
    loopVideoUrl: 'loop_video_url',
    loopPosterUrl: 'loop_poster_url',
    avatarUrl: 'avatar_url'
  }
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key]
    if (value !== undefined) {
      sets.push(`${column} = ?`)
      values.push(value)
    }
  }
  if (sets.length === 0) return
  const now = Date.now()
  sets.push('updated_at = ?')
  values.push(now, orgId)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hosts (id, display_name, headline, subheadline, created_at, updated_at)
       VALUES (?, ?, '', '', ?, ?) ON CONFLICT(id) DO NOTHING`
    ).bind(orgId, orgId, now, now),
    env.DB.prepare(`UPDATE hosts SET ${sets.join(', ')} WHERE id = ?`).bind(...values)
  ])
}

// ─── Agents ──────────────────────────────────────────────────────────────────

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

// ─── History ─────────────────────────────────────────────────────────────────

/**
 * Applies one history operation emitted by the state machine.
 *
 * Note the timestamp columns: `queue_session_status` writes whichever of
 * invited_at / connected_at / ended_at corresponds to the status, so the row
 * accumulates a timeline rather than just a final state. That is what makes
 * "average wait before being invited" answerable later. The agent is recorded
 * on the first status that names one (the invitation) and never blanked.
 */
export async function applyDbOp(env: Env, op: DbOp): Promise<void> {
  switch (op.t) {
    case 'queue_session_insert': {
      const e = op.entry
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO visitors (id, first_name, email, company, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             first_name = excluded.first_name,
             email = COALESCE(excluded.email, visitors.email),
             company = COALESCE(excluded.company, visitors.company),
             last_seen_at = excluded.last_seen_at`
        ).bind(e.visitorId, e.firstName, e.email, e.company, e.joinedAt, e.joinedAt),
        env.DB.prepare(
          `INSERT OR REPLACE INTO queue_sessions
             (id, visitor_id, site_id, page_url, page_title, referrer, question, joined_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`
        ).bind(e.id, e.visitorId, e.siteId, e.pageUrl, e.pageTitle, e.referrer, e.question, e.joinedAt)
      ])
      return
    }

    case 'queue_session_status': {
      const timestampColumn =
        op.status === 'invited'
          ? 'invited_at'
          : op.status === 'connecting' || op.status === 'in_call'
            ? 'connected_at'
            : 'ended_at'
      await env.DB.prepare(
        `UPDATE queue_sessions
         SET status = ?, ${timestampColumn} = COALESCE(${timestampColumn}, ?), agent_id = COALESCE(?, agent_id)
         WHERE id = ?`
      )
        .bind(op.status, op.at, op.agentId ?? null, op.id)
        .run()
      return
    }

    case 'call_start': {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO calls
           (id, visitor_id, site_id, queue_session_id, agent_id, realtime_room_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(op.callId, op.visitorId, op.siteId, op.queueEntryId, op.agentId, op.meetingId, op.at)
        .run()
      return
    }

    case 'call_end': {
      await env.DB.prepare(
        `UPDATE calls SET ended_at = ?, duration_seconds = ?, disconnect_reason = ? WHERE id = ?`
      )
        .bind(op.at, op.durationSeconds, op.reason, op.callId)
        .run()
      return
    }
  }
}

// ─── Offline messages ────────────────────────────────────────────────────────

export interface OfflineMessageInput {
  siteId: string
  visitorId: string | null
  name: string
  email: string | null
  message: string
  pageUrl: string | null
}

export async function insertOfflineMessage(env: Env, input: OfflineMessageInput): Promise<string> {
  const id = randomId('msg')
  await env.DB.prepare(
    `INSERT INTO offline_messages (id, site_id, visitor_id, name, email, message, page_url, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  )
    .bind(id, input.siteId, input.visitorId, input.name, input.email, input.message, input.pageUrl, Date.now())
    .run()
  return id
}

export interface OfflineMessageRow {
  id: string
  site_id: string
  name: string
  email: string | null
  message: string
  page_url: string | null
  created_at: number
  status: string
}

export async function listOfflineMessages(env: Env, limit = 50): Promise<OfflineMessageRow[]> {
  const result = await env.DB.prepare(
    'SELECT id, site_id, name, email, message, page_url, created_at, status FROM offline_messages ORDER BY created_at DESC LIMIT ?'
  )
    .bind(limit)
    .all<OfflineMessageRow>()
  return result.results ?? []
}

// ─── Recent activity ─────────────────────────────────────────────────────────

export interface RecentSession {
  id: string
  firstName: string
  siteId: string
  pageUrl: string | null
  joinedAt: number
  status: string
  /** Who took (or was about to take) the call. Null if nobody ever did. */
  agentName: string | null
}

/**
 * Today's joins with names and outcomes. Exists because a count of "joins" on
 * the metrics strip cannot answer the question it provokes — "who, and what
 * happened to them?" — and a join that expired while the dashboard was closed
 * otherwise leaves no visible trace at all.
 */
export async function recentSessions(env: Env, since: number, limit = 30): Promise<RecentSession[]> {
  const result = await env.DB.prepare(
    `SELECT q.id, COALESCE(v.first_name, '?') AS first_name, q.site_id, q.page_url, q.joined_at, q.status, a.name AS agent_name
     FROM queue_sessions q
     LEFT JOIN visitors v ON v.id = q.visitor_id
     LEFT JOIN agents a ON a.id = q.agent_id
     WHERE q.joined_at >= ? ORDER BY q.joined_at DESC LIMIT ?`
  )
    .bind(since, limit)
    .all<{ id: string; first_name: string; site_id: string; page_url: string | null; joined_at: number; status: string; agent_name: string | null }>()
  return (result.results ?? []).map((row) => ({
    id: row.id,
    firstName: row.first_name,
    siteId: row.site_id,
    pageUrl: row.page_url,
    joinedAt: row.joined_at,
    status: row.status,
    agentName: row.agent_name
  }))
}

export interface InboxItem {
  kind: 'join' | 'message'
  id: string
  name: string
  email: string | null
  company: string | null
  /** The question on a join request, or the message on an offline form. */
  body: string | null
  siteId: string
  pageUrl: string | null
  at: number
  /** VisitorStatus for a join; 'new' for a message. */
  status: string
  /** The agent on a join request; always null for a message. */
  agentName: string | null
}

/**
 * Everything anyone has submitted, newest first: join requests (name, email,
 * question) and offline messages (name, email, message). Two tables, one list,
 * because the question an agent asks is "who reached out and when", not "which
 * table did it go into".
 */
export async function listInbox(env: Env, limit = 100): Promise<InboxItem[]> {
  const [joins, messages] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id, COALESCE(v.first_name, '?') AS name, v.email, v.company, q.question AS body,
              q.site_id, q.page_url, q.joined_at AS at, q.status, a.name AS agent_name
       FROM queue_sessions q
       LEFT JOIN visitors v ON v.id = q.visitor_id
       LEFT JOIN agents a ON a.id = q.agent_id
       ORDER BY q.joined_at DESC LIMIT ?`
    )
      .bind(limit)
      .all<{ id: string; name: string; email: string | null; company: string | null; body: string | null; site_id: string; page_url: string | null; at: number; status: string; agent_name: string | null }>(),
    env.DB.prepare(
      `SELECT id, name, email, message AS body, site_id, page_url, created_at AS at, status
       FROM offline_messages ORDER BY created_at DESC LIMIT ?`
    )
      .bind(limit)
      .all<{ id: string; name: string; email: string | null; body: string; site_id: string; page_url: string | null; at: number; status: string }>()
  ])

  const items: InboxItem[] = [
    ...(joins.results ?? []).map((r) => ({
      kind: 'join' as const, id: r.id, name: r.name, email: r.email, company: r.company, body: r.body,
      siteId: r.site_id, pageUrl: r.page_url, at: r.at, status: r.status, agentName: r.agent_name
    })),
    ...(messages.results ?? []).map((r) => ({
      kind: 'message' as const, id: r.id, name: r.name, email: r.email, company: null, body: r.body,
      siteId: r.site_id, pageUrl: r.page_url, at: r.at, status: r.status, agentName: null
    }))
  ]
  return items.sort((a, b) => b.at - a.at).slice(0, limit)
}

/** Midnight UTC today, in ms — the metrics window everything on the dashboard uses. */
export function startOfTodayUtc(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

// ─── Dashboard metrics ───────────────────────────────────────────────────────

export interface TodayMetrics {
  widgetOpens: number
  queueJoins: number
  callsCompleted: number
  averageWaitSeconds: number | null
  averageCallSeconds: number | null
  bySite: Array<{ siteId: string; queueJoins: number; calls: number }>
  byAgent: Array<{ agentId: string; agentName: string; calls: number; averageCallSeconds: number | null }>
}

/**
 * "Today" is UTC. Good enough for a team dashboard, and stating it here is
 * cheaper than a timezone column nobody will maintain.
 */
export async function getTodayMetrics(env: Env): Promise<TodayMetrics> {
  const since = startOfTodayUtc()

  const batch = await env.DB.batch<Record<string, number | string | null>>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE name = 'widget_opened' AND created_at >= ?").bind(since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM queue_sessions WHERE joined_at >= ?').bind(since),
    env.DB.prepare(
      'SELECT COUNT(*) AS n, AVG(duration_seconds) AS avg_duration FROM calls WHERE ended_at IS NOT NULL AND started_at >= ?'
    ).bind(since),
    env.DB.prepare(
      'SELECT AVG(invited_at - joined_at) AS avg_wait FROM queue_sessions WHERE invited_at IS NOT NULL AND joined_at >= ?'
    ).bind(since),
    env.DB.prepare(
      `SELECT q.site_id AS site_id,
              COUNT(*) AS joins,
              SUM(CASE WHEN q.status = 'completed' THEN 1 ELSE 0 END) AS calls
       FROM queue_sessions q WHERE q.joined_at >= ? GROUP BY q.site_id ORDER BY joins DESC`
    ).bind(since),
    env.DB.prepare(
      `SELECT c.agent_id AS agent_id, COALESCE(a.name, c.agent_id) AS agent_name,
              COUNT(*) AS calls, AVG(c.duration_seconds) AS avg_duration
       FROM calls c LEFT JOIN agents a ON a.id = c.agent_id
       WHERE c.ended_at IS NOT NULL AND c.started_at >= ? AND c.agent_id IS NOT NULL
       GROUP BY c.agent_id ORDER BY calls DESC`
    ).bind(since)
  ])

  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  const rows = (index: number) => batch[index]?.results ?? []
  const callRow = rows(2)[0]
  const waitRow = rows(3)[0]
  const avgWaitMs = waitRow ? Number(waitRow.avg_wait ?? 0) : 0

  return {
    widgetOpens: num(rows(0)[0]?.n),
    queueJoins: num(rows(1)[0]?.n),
    callsCompleted: num(callRow?.n),
    averageWaitSeconds: avgWaitMs > 0 ? Math.round(avgWaitMs / 1000) : null,
    averageCallSeconds: callRow?.avg_duration ? Math.round(Number(callRow.avg_duration)) : null,
    bySite: rows(4).map((row) => ({
      siteId: String(row.site_id ?? ''),
      queueJoins: num(row.joins),
      calls: num(row.calls)
    })),
    byAgent: rows(5).map((row) => ({
      agentId: String(row.agent_id ?? ''),
      agentName: String(row.agent_name ?? ''),
      calls: num(row.calls),
      averageCallSeconds: row.avg_duration ? Math.round(Number(row.avg_duration)) : null
    }))
  }
}

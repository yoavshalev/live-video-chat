/**
 * What happened: queue sessions and calls as the machine reports them, and the
 * two reads built on top — today's activity and the inbox.
 */

import type { Env } from '../../types'
import type { DbOp } from '../../shared/machine'

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
      if (op.status === 'waiting') {
        // Back in line after a failed call. Clearing ended_at matters: the
        // generic branch below would stamp it, and an active session would
        // read as finished everywhere the history is shown.
        await env.DB.prepare(`UPDATE queue_sessions SET status = 'waiting', ended_at = NULL, agent_id = COALESCE(?, agent_id) WHERE id = ?`)
          .bind(op.agentId ?? null, op.id)
          .run()
        return
      }
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

/** Midnight UTC today, in ms — the metrics window everything on the dashboard uses. */
export function startOfTodayUtc(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
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

// ─── Inbox ───────────────────────────────────────────────────────────────────

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

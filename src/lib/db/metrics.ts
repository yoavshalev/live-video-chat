/** Today's numbers for the dashboard's metric strip. */

import type { Env } from '../../types'
import { startOfTodayUtc } from './history'

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

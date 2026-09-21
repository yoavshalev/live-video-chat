/** The organization row (hosts.id = ORG_ID): the intro clip and its wording. */

import type { Env, HostRow } from '../../types'
import type { HostProfileView } from '../../shared/protocol'

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

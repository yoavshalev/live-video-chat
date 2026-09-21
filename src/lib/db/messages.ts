/** The offline form: what a visitor leaves when nobody is live. */

import type { Env } from '../../types'
import { randomId } from '../security'

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

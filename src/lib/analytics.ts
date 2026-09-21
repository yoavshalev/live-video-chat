/**
 * First-party funnel events.
 *
 * Two rules, both of them about not letting measurement damage the product:
 *   1. Nothing here is ever awaited on a path a visitor is waiting on. Callers
 *      hand the promise to `ctx.waitUntil` or fire and forget.
 *   2. A failure is logged and dropped. A D1 hiccup must not stop a queue.
 */

import type { Env } from '../types'
import { randomId } from './security'

/** The funnel, start to finish. Adding a name here is the only way to record one. */
export type EventName =
  | 'widget_impression'
  | 'widget_opened'
  | 'talk_clicked'
  | 'join_form_started'
  | 'queue_joined'
  | 'queue_left'
  | 'call_invited'
  | 'call_invite_accepted'
  | 'call_invite_declined'
  | 'call_invite_expired'
  | 'call_started'
  | 'call_completed'
  | 'offline_message_sent'
  | 'av_setup_shown'
  | 'av_permission_denied'

export const EVENT_NAMES: ReadonlySet<string> = new Set<EventName>([
  'widget_impression',
  'widget_opened',
  'talk_clicked',
  'join_form_started',
  'queue_joined',
  'queue_left',
  'call_invited',
  'call_invite_accepted',
  'call_invite_declined',
  'call_invite_expired',
  'call_started',
  'call_completed',
  'offline_message_sent',
  'av_setup_shown',
  'av_permission_denied'
])

export interface AnalyticsEvent {
  name: EventName | string
  siteId?: string | null
  visitorId?: string | null
  pageUrl?: string | null
  props?: Record<string, unknown> | null
  createdAt?: number
}

export async function recordEvents(env: Env, events: AnalyticsEvent[]): Promise<void> {
  if (events.length === 0) return
  try {
    const now = Date.now()
    const statements = events.slice(0, 50).map((event) =>
      env.DB.prepare(
        'INSERT INTO analytics_events (id, name, site_id, visitor_id, page_url, props, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        randomId('ev'),
        String(event.name).slice(0, 64),
        event.siteId ?? null,
        event.visitorId ?? null,
        event.pageUrl ?? null,
        event.props ? JSON.stringify(event.props).slice(0, 1000) : null,
        event.createdAt ?? now
      )
    )
    await env.DB.batch(statements)
  } catch (error) {
    console.error('[analytics]', error instanceof Error ? error.message : String(error))
  }
}

export async function recordEvent(env: Env, event: AnalyticsEvent): Promise<void> {
  await recordEvents(env, [event])
}

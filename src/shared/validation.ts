/**
 * Inbound validation and sanitisation.
 *
 * No schema library: the whole surface is one flat union of small payloads, and
 * a validator is a few hundred bytes of code against tens of kilobytes of
 * dependency in a bundle that every embedding site downloads. The rule is that
 * nothing reaches the state machine without passing through here.
 *
 * Everything a visitor types is treated as hostile. Text is stripped of tags and
 * control characters and hard-capped in length before it is stored, so that the
 * host dashboard — which renders these values — has nothing to escape badly.
 */

import type { ClientMessage } from './protocol'

export const LIMITS = {
  firstName: 40,
  email: 120,
  company: 80,
  question: 500,
  message: 2000,
  pageUrl: 500,
  pageTitle: 200,
  referrer: 300,
  visitorId: 64,
  siteId: 40,
  commandId: 64
} as const

/**
 * Strips anything that looks like markup, flattens control characters and
 * collapses whitespace. Visitor text is rendered as text in exactly one place
 * (the host dashboard) and this is the belt to that suspenders.
 */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function sanitizeOptional(value: unknown, maxLength: number): string | null {
  const text = sanitizeText(value, maxLength)
  return text.length > 0 ? text : null
}

/** Very deliberately permissive: a bad address costs us a follow-up, not security. */
export function sanitizeEmail(value: unknown): string | null {
  const text = sanitizeText(value, LIMITS.email).toLowerCase()
  if (!text) return null
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(text) ? text : null
}

/**
 * Page URLs are reported by the visitor's browser and are shown to the host as a
 * link, so anything but http(s) is dropped rather than sanitised — there is no
 * such thing as a safe `javascript:` page URL.
 */
export function sanitizeUrl(value: unknown, maxLength: number = LIMITS.pageUrl): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, maxLength)
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().slice(0, maxLength)
  } catch {
    return null
  }
}

/** Ids we generated. Anything with unexpected characters is simply not one of ours. */
export function isSafeId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value)
}

export interface ParseFailure {
  ok: false
  reason: string
}
export interface ParseSuccess {
  ok: true
  message: ClientMessage
}

/**
 * Parses one raw WebSocket frame into a ClientMessage. Returns a failure rather
 * than throwing, because a malformed frame is an expected event on a public
 * endpoint and must not be able to take a socket down.
 */
export function parseClientMessage(raw: string | ArrayBuffer): ParseSuccess | ParseFailure {
  if (typeof raw !== 'string') return { ok: false, reason: 'binary frames are not accepted' }
  if (raw.length > 8192) return { ok: false, reason: 'message too large' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'not an object' }

  const envelope = parsed as { type?: unknown; payload?: unknown }
  if (typeof envelope.type !== 'string') return { ok: false, reason: 'missing type' }
  const payload = (typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {}) as Record<
    string,
    unknown
  >

  const commandId = isSafeId(payload.commandId, LIMITS.commandId) ? payload.commandId : null
  const now = Date.now()

  switch (envelope.type) {
    case 'HEARTBEAT':
      return { ok: true, message: { type: 'HEARTBEAT', timestamp: now, payload: {} } }

    // Host commands that carry nothing but their own id.
    case 'HOST_GO_LIVE':
    case 'HOST_GO_OFFLINE':
    case 'HOST_PAUSE':
    case 'HOST_RESUME':
    case 'CALL_ACCEPT_NEXT':
    case 'QUEUE_LEAVE':
    case 'VISITOR_ACCEPT_INVITE':
    case 'VISITOR_DECLINE_INVITE': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      return { ok: true, message: { type: envelope.type, timestamp: now, payload: { commandId } } as ClientMessage }
    }

    case 'HOST_SET_ASSIGNMENT': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      if (payload.mode !== 'auto' && payload.mode !== 'manual') return { ok: false, reason: 'mode must be auto or manual' }
      return {
        ok: true,
        message: { type: 'HOST_SET_ASSIGNMENT', timestamp: now, payload: { commandId, mode: payload.mode } }
      }
    }

    case 'CALL_ACCEPT_VISITOR':
    case 'CALL_DECLINE_VISITOR': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      if (!isSafeId(payload.visitorId, LIMITS.visitorId)) return { ok: false, reason: 'bad visitorId' }
      return {
        ok: true,
        message: { type: envelope.type, timestamp: now, payload: { commandId, visitorId: payload.visitorId } } as ClientMessage
      }
    }

    case 'CALL_END': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      return {
        ok: true,
        message: {
          type: 'CALL_END',
          timestamp: now,
          payload: { commandId, reason: sanitizeText(payload.reason, 40) || undefined }
        }
      }
    }

    case 'CALL_MEDIA_JOINED':
    case 'CALL_MEDIA_LEFT': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      if (!isSafeId(payload.callId, LIMITS.commandId)) return { ok: false, reason: 'bad callId' }
      return {
        ok: true,
        message: { type: envelope.type, timestamp: now, payload: { commandId, callId: payload.callId } } as ClientMessage
      }
    }

    case 'QUEUE_JOIN': {
      if (!commandId) return { ok: false, reason: 'missing commandId' }
      const firstName = sanitizeText(payload.firstName, LIMITS.firstName)
      if (firstName.length < 1) return { ok: false, reason: 'first name is required' }
      const pageUrl = sanitizeUrl(payload.pageUrl)
      if (!pageUrl) return { ok: false, reason: 'bad pageUrl' }

      return {
        ok: true,
        message: {
          type: 'QUEUE_JOIN',
          timestamp: now,
          payload: {
            commandId,
            firstName,
            email: sanitizeEmail(payload.email) ?? undefined,
            company: sanitizeOptional(payload.company, LIMITS.company) ?? undefined,
            question: sanitizeOptional(payload.question, LIMITS.question) ?? undefined,
            pageUrl,
            pageTitle: sanitizeOptional(payload.pageTitle, LIMITS.pageTitle) ?? undefined,
            referrer: sanitizeUrl(payload.referrer, LIMITS.referrer) ?? undefined
          }
        }
      }
    }

    default:
      return { ok: false, reason: `unknown type ${envelope.type.slice(0, 40)}` }
  }
}

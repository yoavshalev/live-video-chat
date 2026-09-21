/**
 * A WebSocket that reconnects, shared by the widget and the dashboard.
 *
 * Three things it has to get right, all of them learned from the failure modes
 * in README "Presence and failure handling":
 *
 *   Backoff with jitter. When the Worker restarts, every widget on every site
 *   reconnects at once. Without jitter they synchronise into a thundering herd
 *   that keeps the thing they are reconnecting to busy.
 *
 *   Keepalive that does not cost anything. The literal string "ping" is answered
 *   by the Durable Object's auto-response, so a heartbeat from hundreds of idle
 *   widgets never wakes the object out of hibernation.
 *
 *   Reconnect when the tab comes back. Mobile Safari freezes backgrounded tabs
 *   and the socket dies silently; waiting for a timer to notice wastes the grace
 *   window a returning visitor needs.
 */

import type { ClientMessage, ServerMessage } from '../../src/shared/protocol'

export type SocketStatus = 'connecting' | 'open' | 'closed'

export interface SocketOptions {
  url: () => string
  onMessage: (message: ServerMessage) => void
  onStatus?: (status: SocketStatus) => void
  /** Called when reconnection has failed enough times to fall back to polling. */
  onGiveUp?: () => void
  maxAttempts?: number
}

const HEARTBEAT_MS = 25_000
const MAX_BACKOFF_MS = 30_000

export class ReconnectingSocket {
  private ws: WebSocket | null = null
  private attempt = 0
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly maxAttempts: number

  constructor(private readonly options: SocketOptions) {
    this.maxAttempts = options.maxAttempts ?? 12
  }

  get status(): SocketStatus {
    if (this.closed) return 'closed'
    if (this.ws?.readyState === WebSocket.OPEN) return 'open'
    return 'connecting'
  }

  connect(): void {
    if (this.closed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    this.options.onStatus?.('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.options.url())
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      this.options.onStatus?.('open')
      this.startHeartbeat()
    })

    socket.addEventListener('message', (event) => {
      // The auto-response keepalive. Not JSON, and not interesting.
      if (event.data === 'pong') return
      try {
        this.options.onMessage(JSON.parse(String(event.data)) as ServerMessage)
      } catch {
        // A frame we cannot parse is not worth tearing the connection down for.
      }
    })

    socket.addEventListener('close', () => {
      this.stopHeartbeat()
      this.ws = null
      if (this.closed) return
      this.options.onStatus?.('connecting')
      this.scheduleRetry()
    })

    socket.addEventListener('error', () => {
      // 'close' always follows; retrying from both would double the backoff rate.
      try {
        socket.close()
      } catch {
        /* already gone */
      }
    })
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.closed = true
    this.stopHeartbeat()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
    this.options.onStatus?.('closed')
  }

  /** Called when the tab becomes visible again — a frozen tab's socket is often already dead. */
  nudge(): void {
    if (this.closed) return
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.attempt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.connect()
  }

  private scheduleRetry(): void {
    if (this.closed) return
    if (this.attempt >= this.maxAttempts) {
      this.options.onGiveUp?.()
      return
    }
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt)
    // Up to 30% jitter, so a fleet of widgets does not reconnect in lockstep.
    const delay = base * (0.7 + Math.random() * 0.3)
    this.attempt += 1
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('ping')
        } catch {
          /* the close handler will deal with it */
        }
      }
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}

/** Short, collision-resistant ids for the commandId idempotency guard. */
export function commandId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
  return `c${random}`
}

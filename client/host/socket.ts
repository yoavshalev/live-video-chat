/**
 * The one socket to the Durable Object. Nothing here decides anything: every
 * button sends a command and waits for the server to say what happened — which
 * is why two agents pressing ACCEPT on the same visitor is safe, and why a
 * button never optimistically shows a state the server has not confirmed.
 */

import type { ServerMessage } from '../../src/shared/protocol'
import type { clientMsg } from '../../src/shared/protocol'
import { ReconnectingSocket } from '../shared/socket'
import { boot } from './boot'
import { toast } from './dom'

let socket: ReconnectingSocket | null = null

export function connectSocket(handlers: { onMessage: (message: ServerMessage) => void; onStatus: (open: boolean) => void }): void {
  socket = new ReconnectingSocket({
    url: () => boot.wsUrl,
    onMessage: handlers.onMessage,
    onStatus: (status) => handlers.onStatus(status === 'open'),
    onGiveUp: () => toast('Lost the connection to the server. Reload the page.', true)
  })
  socket.connect()
}

export function send(message: ReturnType<typeof clientMsg>): void {
  if (!socket?.send(message)) toast('Not connected — that did not go through.', true)
}

/** A frozen tab's socket is usually already dead; nudging beats waiting out the backoff. */
export function nudgeSocket(): void {
  socket?.nudge()
}

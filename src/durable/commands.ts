/**
 * Turns a message from a socket into a reducer command — or into a refusal.
 *
 * Authority comes from the socket's own attachment, set at upgrade time after
 * the Worker authenticated the request. A payload claiming to be an agent is
 * just a payload; a payload naming a call has to name the caller's own call.
 * Pure apart from the two callbacks it is handed (fresh ids, and a look-up of
 * the caller's current call), which is what makes it testable without a
 * Durable Object.
 */

import type { CallRecord, Command, Ids } from '../shared/machine'
import type { ClientMessage, ErrorCode, SocketAttachment } from '../shared/protocol'
import { randomId } from '../lib/security'

export type Outcome =
  | { kind: 'command'; command: Command }
  | { kind: 'error'; code: ErrorCode; message: string; commandId?: string }
  | { kind: 'ignore' }

export interface CommandContext {
  message: ClientMessage
  attachment: SocketAttachment
  now: number
  /** Fresh ids for the reducer to spend; `size` when the caller needs exactly one. */
  idPool(size?: number): Ids[]
  /** The caller's own call, by socket identity — an agent's seat or a visitor's. */
  ownCall(): Promise<CallRecord | undefined>
}

const ignore: Outcome = { kind: 'ignore' }
const command = (c: Command): Outcome => ({ kind: 'command', command: c })

export async function commandFromMessage(ctx: CommandContext): Promise<Outcome> {
  const { message, attachment, now } = ctx
  const agentId = attachment.role === 'host' ? attachment.agentId : undefined
  const visitorId = attachment.visitorId
  const agentsOnly: Outcome = { kind: 'error', code: 'unauthorized', message: 'agents only' }

  switch (message.type) {
    case 'HEARTBEAT':
      return ignore

    // ── Agent controls ──────────────────────────────────────────────────────
    case 'HOST_GO_LIVE':
      return agentId ? command({ t: 'HOST_GO_LIVE', now, commandId: message.payload.commandId, agentId, ids: ctx.idPool() }) : agentsOnly
    case 'HOST_GO_OFFLINE':
      return agentId ? command({ t: 'HOST_GO_OFFLINE', now, commandId: message.payload.commandId, agentId, ids: ctx.idPool() }) : agentsOnly
    case 'HOST_PAUSE':
      return agentId ? command({ t: 'HOST_PAUSE', now, commandId: message.payload.commandId, agentId }) : agentsOnly
    case 'HOST_RESUME':
      return agentId ? command({ t: 'HOST_RESUME', now, commandId: message.payload.commandId, agentId, ids: ctx.idPool() }) : agentsOnly
    case 'HOST_SET_ASSIGNMENT':
      return agentId ? command({ t: 'HOST_SET_ASSIGNMENT', now, commandId: message.payload.commandId, mode: message.payload.mode, ids: ctx.idPool() }) : agentsOnly
    case 'CALL_ACCEPT_NEXT':
      return agentId ? command({ t: 'ACCEPT_NEXT', now, commandId: message.payload.commandId, agentId, ids: ctx.idPool(1) }) : agentsOnly
    case 'CALL_ACCEPT_VISITOR':
      return agentId
        ? command({ t: 'ACCEPT_VISITOR', now, commandId: message.payload.commandId, agentId, visitorId: message.payload.visitorId, ids: ctx.idPool(1) })
        : agentsOnly
    case 'CALL_DECLINE_VISITOR':
      return agentId
        ? command({ t: 'DECLINE_VISITOR', now, commandId: message.payload.commandId, agentId, visitorId: message.payload.visitorId, ids: ctx.idPool() })
        : agentsOnly

    // ── Either side, their own call only ────────────────────────────────────
    case 'CALL_END': {
      const call = await ctx.ownCall()
      if (!call) return { kind: 'error', code: 'no_active_call', message: 'There is no call to end.', commandId: message.payload.commandId }
      return command({
        t: 'CALL_END', now, commandId: message.payload.commandId, callId: call.callId,
        reason: agentId ? 'host_ended' : 'visitor_left', ids: ctx.idPool()
      })
    }
    case 'CALL_MEDIA_JOINED':
    case 'CALL_MEDIA_LEFT': {
      // The payload's callId has to agree with the caller's own call. Otherwise
      // any dashboard could mark another agent's call as connected, or start
      // its disconnect clock.
      const call = await ctx.ownCall()
      if (!call || call.callId !== message.payload.callId) return ignore
      return command({ t: message.type === 'CALL_MEDIA_JOINED' ? 'MEDIA_JOINED' : 'MEDIA_LEFT', now, callId: call.callId, who: agentId ? 'host' : 'visitor' })
    }

    // ── Visitors ────────────────────────────────────────────────────────────
    case 'QUEUE_JOIN': {
      if (!visitorId || !attachment.siteId) return { kind: 'error', code: 'unauthorized', message: 'no visitor identity' }
      const p = message.payload
      return command({
        t: 'QUEUE_JOIN', now, commandId: p.commandId, visitorId, queueEntryId: randomId('qs'),
        firstName: p.firstName, email: p.email ?? null, company: p.company ?? null, question: p.question ?? null,
        // siteId comes from the socket, which the Worker validated against the
        // Origin header. The payload does not get a vote.
        siteId: attachment.siteId, pageUrl: p.pageUrl, pageTitle: p.pageTitle ?? null, referrer: p.referrer ?? null,
        ids: ctx.idPool()
      })
    }
    case 'QUEUE_LEAVE':
      return visitorId ? command({ t: 'QUEUE_LEAVE', now, commandId: message.payload.commandId, visitorId, ids: ctx.idPool() }) : ignore
    case 'VISITOR_ACCEPT_INVITE':
      return visitorId ? command({ t: 'VISITOR_ACCEPT_INVITE', now, commandId: message.payload.commandId, visitorId }) : ignore
    case 'VISITOR_DECLINE_INVITE':
      return visitorId ? command({ t: 'VISITOR_DECLINE_INVITE', now, commandId: message.payload.commandId, visitorId, ids: ctx.idPool() }) : ignore
  }
}

/**
 * The reducer: one command in, a new state and a list of effects out.
 *
 * `reduce` wraps `apply` with the idempotency guard; `apply` is the switch
 * over every command, each case short enough to read in one go because the
 * work lives in ./transitions.ts.
 */

import { serverMsg } from '../protocol'
import type { RoomSettings } from '../../config'
import type { AgentState, CallRecord, Command, Effect, QueueEntry, Result, RoomState } from './types'
import { callById, callFor, deriveStatus, inviteFor, positionView, queueEntryView } from './views'
import {
  agentOffline,
  assign,
  clearInvite,
  endCall,
  err,
  invite,
  patchEntry,
  rejectAgent,
  rejectVisitor,
  removeVisitor,
  restoreVisitor,
  takeIds,
  tick,
  withAgent,
  withCall
} from './transitions'

const COMMAND_HISTORY = 64

export function reduce(state: RoomState, command: Command, settings: RoomSettings): Result {
  // Idempotency. A client that retries after a dropped socket replays the same
  // commandId; applying it twice would double-accept or double-end a call.
  const commandId = 'commandId' in command ? command.commandId : null
  if (commandId && state.recentCommandIds.includes(commandId)) return { state, effects: [] }

  const result = apply(state, command, settings)

  if (commandId && result.state !== state) {
    const ids = [...result.state.recentCommandIds, commandId]
    result.state = {
      ...result.state,
      recentCommandIds: ids.length > COMMAND_HISTORY ? ids.slice(-COMMAND_HISTORY) : ids
    }
  }
  return result
}

function apply(state: RoomState, command: Command, settings: RoomSettings): Result {
  switch (command.t) {
    // ── Agent connection lifecycle ──────────────────────────────────────────
    case 'HOST_CONNECT': {
      const existing = state.agents[command.agentId]
      // Trusting an absolute count when offered is what lets a stored counter
      // recover after a crash left it stale.
      const agent: AgentState = existing
        ? { ...existing, name: command.name, connections: command.connections ?? existing.connections + 1, disconnectedAt: null }
        : {
            id: command.agentId,
            name: command.name,
            intent: 'offline',
            connections: command.connections ?? 1,
            disconnectedAt: null,
            liveSince: null,
            lastAssignedAt: 0
          }
      return { state: withAgent(state, agent), effects: [] }
    }

    case 'HOST_DISCONNECT': {
      const agent = state.agents[command.agentId]
      if (!agent) return { state, effects: [] }
      const remaining = Math.max(0, command.remaining)
      return {
        state: withAgent(state, {
          ...agent,
          connections: remaining,
          // Only start the clock when the *last* dashboard tab goes. Closing one
          // of two tabs must not begin taking the agent offline.
          disconnectedAt: remaining === 0 ? command.now : null
        }),
        effects: []
      }
    }

    // ── Agent presence controls ─────────────────────────────────────────────
    case 'HOST_GO_LIVE': {
      const agent = state.agents[command.agentId]
      if (!agent) return { state, effects: [] }
      if (agent.intent === 'live') return { state, effects: [] }
      const next = withAgent(state, { ...agent, intent: 'live', liveSince: agent.liveSince ?? command.now })
      // Coming online with people already waiting: they have been waiting for
      // exactly this.
      return assign(next, command.now, command.ids, settings, [])
    }

    case 'HOST_GO_OFFLINE': {
      if (!state.agents[command.agentId]) return { state, effects: [] }
      const offline = agentOffline(state, command.agentId, command.now, settings)
      return assign(offline.state, command.now, command.ids, settings, offline.effects)
    }

    case 'HOST_PAUSE': {
      const agent = state.agents[command.agentId]
      if (!agent || agent.intent === 'offline') {
        return rejectAgent(state, command.agentId, 'host_offline', 'Go live before pausing.', command.commandId)
      }
      return { state: withAgent(state, { ...agent, intent: 'paused' }), effects: [] }
    }

    case 'HOST_RESUME': {
      const agent = state.agents[command.agentId]
      if (!agent || agent.intent === 'offline') {
        return rejectAgent(state, command.agentId, 'host_offline', 'Go live first.', command.commandId)
      }
      return assign(withAgent(state, { ...agent, intent: 'live' }), command.now, command.ids, settings, [])
    }

    case 'HOST_SET_ASSIGNMENT': {
      const next = { ...state, assignment: command.mode }
      return assign(next, command.now, command.ids, settings, [])
    }

    // ── Visitor connection lifecycle ────────────────────────────────────────
    case 'VISITOR_CONNECT': {
      const index = state.queue.findIndex((e) => e.visitorId === command.visitorId)
      if (index < 0) return { state, effects: [] }
      // Reconnected inside the grace window: the queue entry was never removed,
      // so their position is exactly what it was.
      return {
        state: { ...state, queue: patchEntry(state.queue, index, { connected: true, disconnectedAt: null }) },
        effects: []
      }
    }

    case 'VISITOR_DISCONNECT': {
      if (command.remaining > 0) return { state, effects: [] }
      let next = state
      const index = state.queue.findIndex((e) => e.visitorId === command.visitorId)
      if (index >= 0) {
        next = { ...next, queue: patchEntry(next.queue, index, { connected: false, disconnectedAt: command.now }) }
      }
      // A visitor whose socket dies mid-call starts the media reconnect clock.
      const call = callFor(next, command.visitorId)
      if (call && call.visitorLeftAt === null) {
        next = withCall(next, { ...call, visitorPresent: false, visitorLeftAt: command.now })
      }
      return { state: next, effects: [] }
    }

    // ── Queue ───────────────────────────────────────────────────────────────
    case 'QUEUE_JOIN': {
      const status = deriveStatus(state)
      if (status === 'offline') {
        return rejectVisitor(state, command.visitorId, 'host_offline', 'Nobody is available right now.', command.commandId)
      }
      if (status === 'paused') {
        return rejectVisitor(state, command.visitorId, 'host_paused', 'New conversations are paused for a moment.', command.commandId)
      }
      if (callFor(state, command.visitorId)) {
        return rejectVisitor(state, command.visitorId, 'call_in_progress', "You're already in a call.", command.commandId)
      }
      // Duplicate join from a second tab. Not an error the visitor caused, so we
      // answer with their real position instead of only complaining.
      if (state.queue.some((e) => e.visitorId === command.visitorId)) {
        const position = positionView(state, command.visitorId, settings, command.now)
        const effects: Effect[] = [
          { k: 'send_visitor', visitorId: command.visitorId, message: err('already_queued', "You're already in line.", command.commandId) }
        ]
        if (position) {
          effects.push({ k: 'send_visitor', visitorId: command.visitorId, message: serverMsg('QUEUE_POSITION_UPDATE', position, command.now) })
        }
        return { state, effects }
      }
      if (state.queue.length >= settings.maxQueueLength) {
        return rejectVisitor(state, command.visitorId, 'queue_full', 'The line is full right now — try again shortly.', command.commandId)
      }

      const entry: QueueEntry = {
        id: command.queueEntryId,
        visitorId: command.visitorId,
        firstName: command.firstName,
        email: command.email,
        company: command.company,
        question: command.question,
        siteId: command.siteId,
        pageUrl: command.pageUrl,
        pageTitle: command.pageTitle,
        referrer: command.referrer,
        joinedAt: command.now,
        status: 'waiting',
        assignedTo: null,
        connected: true,
        disconnectedAt: null
      }
      const next = { ...state, queue: [...state.queue, entry] }
      const effects: Effect[] = [
        { k: 'db', op: { t: 'queue_session_insert', entry } },
        { k: 'send_agents', message: serverMsg('VISITOR_JOINED', { entry: queueEntryView(entry) }, command.now) },
        { k: 'analytics', name: 'queue_joined', siteId: entry.siteId, visitorId: entry.visitorId, agentId: null }
      ]
      // In auto mode a free agent is handed the arrival straight away. In manual
      // mode it waits for somebody to press Accept.
      return assign(next, command.now, command.ids, settings, effects)
    }

    case 'QUEUE_LEAVE': {
      const removed = removeVisitor(state, command.visitorId, 'left', command.now, command.commandId)
      return assign(removed.state, command.now, command.ids, settings, removed.effects)
    }

    case 'DECLINE_VISITOR': {
      const removed = removeVisitor(state, command.visitorId, 'declined', command.now, command.commandId)
      return assign(removed.state, command.now, command.ids, settings, removed.effects)
    }

    // ── Invitations ─────────────────────────────────────────────────────────
    case 'ACCEPT_NEXT': {
      const head = state.queue.find((e) => e.status === 'waiting')
      if (!head) return rejectAgent(state, command.agentId, 'nothing_to_accept', 'Nobody is waiting.', command.commandId)
      const [ids] = takeIds(command.ids)
      if (!ids) return { state, effects: [] }
      return invite(state, command.agentId, head.visitorId, command.now, ids, settings, command.commandId)
    }

    case 'ACCEPT_VISITOR': {
      const [ids] = takeIds(command.ids)
      if (!ids) return { state, effects: [] }
      return invite(state, command.agentId, command.visitorId, command.now, ids, settings, command.commandId)
    }

    case 'VISITOR_ACCEPT_INVITE': {
      const inv = inviteFor(state, command.visitorId)
      if (!inv) {
        return rejectVisitor(state, command.visitorId, 'no_invite', 'That invitation is no longer active.', command.commandId)
      }
      // The "invitation expires exactly as the visitor accepts" race. The alarm
      // may not have fired yet, so the deadline is re-checked here and the
      // reducer — not the timer — is the authority.
      if (command.now > inv.expiresAt) {
        const cleared = clearInvite(state, inv.agentId, 'expired', command.now)
        return { state: cleared.state, effects: cleared.effects }
      }
      const call = state.calls[inv.agentId]
      if (!call || call.callId !== inv.callId) {
        return rejectVisitor(state, command.visitorId, 'internal', 'Call is no longer available.', command.commandId)
      }

      const { [inv.agentId]: _dropped, ...invites } = state.invites
      const next: RoomState = withCall(
        { ...state, invites, queue: state.queue.filter((e) => e.visitorId !== command.visitorId) },
        { ...call, acceptedAt: command.now, status: call.meetingId ? 'connecting' : 'provisioning' }
      )
      const connecting = serverMsg(
        'CALL_CONNECTING',
        { callId: call.callId, callSecret: call.callSecret, visitorId: call.visitorId, firstName: call.firstName, agentId: call.agentId, agentName: call.agentName },
        command.now
      )
      return {
        state: next,
        effects: [
          { k: 'db', op: { t: 'queue_session_status', id: call.queueEntryId, status: 'connecting', at: command.now, agentId: call.agentId } },
          { k: 'send_visitor', visitorId: command.visitorId, message: connecting },
          { k: 'send_agent', agentId: call.agentId, message: connecting },
          { k: 'analytics', name: 'call_invite_accepted', siteId: call.siteId, visitorId: command.visitorId, agentId: call.agentId }
        ]
      }
    }

    case 'VISITOR_DECLINE_INVITE': {
      const inv = inviteFor(state, command.visitorId)
      if (!inv) return rejectVisitor(state, command.visitorId, 'no_invite', 'No invitation to decline.', command.commandId)
      const cleared = clearInvite(state, inv.agentId, 'declined', command.now)
      return assign(cleared.state, command.now, command.ids, settings, cleared.effects)
    }

    // ── Media provisioning ──────────────────────────────────────────────────
    case 'CALL_PROVISIONED': {
      const call = callById(state, command.callId)
      if (!call) return { state, effects: [] }
      const next = withCall(state, {
        ...call,
        meetingId: command.meetingId,
        status: call.acceptedAt !== null ? 'connecting' : call.status
      })
      return {
        state: next,
        effects: [
          {
            k: 'db',
            op: {
              t: 'call_start',
              callId: call.callId,
              agentId: call.agentId,
              visitorId: call.visitorId,
              queueEntryId: call.queueEntryId,
              siteId: call.siteId,
              meetingId: command.meetingId,
              at: command.now
            }
          }
        ]
      }
    }

    case 'CALL_PROVISION_FAILED': {
      const call = callById(state, command.callId)
      if (!call) return { state, effects: [] }
      // The failure was ours, not the visitor's: they keep their place and the
      // agent is freed. Automatic assignment then waits provisionRetrySeconds
      // before trying again (with the next agent in the rotation), because the
      // likeliest cause is RealtimeKit being down or misconfigured, and the
      // alternative is inviting, failing and re-inviting as fast as the network
      // allows. An agent pressing Accept during the hold still gets a real try.
      const restored = restoreVisitor(state, call.agentId, command.now, settings)
      const held: RoomState = { ...restored.state, provisionHoldUntil: command.now + settings.provisionRetrySeconds * 1000 }
      const effects: Effect[] = [
        ...restored.effects,
        { k: 'send_agent', agentId: call.agentId, message: err('provision_failed', `Could not start the call: ${command.error}`) },
        { k: 'send_visitor', visitorId: call.visitorId, message: err('provision_failed', 'We could not start the call. You kept your place in line.') },
        { k: 'release_call', callId: call.callId, meetingId: call.meetingId }
      ]
      return { state: held, effects }
    }

    // ── In-call presence ────────────────────────────────────────────────────
    case 'MEDIA_JOINED': {
      const call = callById(state, command.callId)
      // No meeting yet means nobody can have joined one: a presence report
      // before provisioning finished is bogus, and honouring it would mark a
      // call live that cannot carry media.
      if (!call || call.meetingId === null) return { state, effects: [] }
      const updated: CallRecord = {
        ...call,
        hostPresent: command.who === 'host' ? true : call.hostPresent,
        visitorPresent: command.who === 'visitor' ? true : call.visitorPresent,
        hostLeftAt: command.who === 'host' ? null : call.hostLeftAt,
        visitorLeftAt: command.who === 'visitor' ? null : call.visitorLeftAt
      }
      const bothPresent = updated.hostPresent && updated.visitorPresent
      const becameLive = bothPresent && call.status !== 'in_call'
      const next = withCall(state, {
        ...updated,
        status: bothPresent ? 'in_call' : updated.status,
        connectedAt: becameLive ? (call.connectedAt ?? command.now) : call.connectedAt
      })
      if (!becameLive) return { state: next, effects: [] }
      return {
        state: next,
        effects: [
          { k: 'broadcast', message: serverMsg('CALL_STARTED', { callId: call.callId, agentId: call.agentId, startedAt: command.now }, command.now) },
          { k: 'db', op: { t: 'queue_session_status', id: call.queueEntryId, status: 'in_call', at: command.now, agentId: call.agentId } },
          { k: 'analytics', name: 'call_started', siteId: call.siteId, visitorId: call.visitorId, agentId: call.agentId }
        ]
      }
    }

    case 'MEDIA_LEFT': {
      const call = callById(state, command.callId)
      if (!call) return { state, effects: [] }
      return {
        state: withCall(state, {
          ...call,
          hostPresent: command.who === 'host' ? false : call.hostPresent,
          visitorPresent: command.who === 'visitor' ? false : call.visitorPresent,
          hostLeftAt: command.who === 'host' ? (call.hostLeftAt ?? command.now) : call.hostLeftAt,
          visitorLeftAt: command.who === 'visitor' ? (call.visitorLeftAt ?? command.now) : call.visitorLeftAt
        }),
        effects: []
      }
    }

    case 'CALL_END': {
      const call = callById(state, command.callId)
      if (!call) return { state, effects: [] }
      const ended = endCall(state, call.agentId, command.now, command.reason)
      return assign(ended.state, command.now, command.ids, settings, ended.effects)
    }

    // ── Timers ──────────────────────────────────────────────────────────────
    case 'TICK':
      return tick(state, command.now, command.ids, settings)
  }
}

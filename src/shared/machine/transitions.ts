/**
 * The transitions the reducer composes: inviting, clearing and restoring,
 * ending calls, taking an agent offline, round-robin assignment and the alarm
 * tick. Each returns a new state plus the effects that follow from it; none
 * touches the world.
 */

import type { CallEndReason, ErrorCode, ServerMessage, VisitorStatus } from '../protocol'
import { serverMsg } from '../protocol'
import type { RoomSettings } from '../../config'
import type { AgentState, CallRecord, Effect, Ids, QueueEntry, Result, RoomState } from './types'
import { availableAgents, inviteFor, liveAgents, selfView } from './views'

// ─── Small helpers ───────────────────────────────────────────────────────────

export function err(code: ErrorCode, message: string, commandId?: string): ServerMessage {
  return serverMsg('ERROR', { code, message, commandId })
}

export function rejectVisitor(state: RoomState, visitorId: string, code: ErrorCode, message: string, commandId?: string): Result {
  return { state, effects: [{ k: 'send_visitor', visitorId, message: err(code, message, commandId) }] }
}

export function rejectAgent(state: RoomState, agentId: string, code: ErrorCode, message: string, commandId?: string): Result {
  return { state, effects: [{ k: 'send_agent', agentId, message: err(code, message, commandId) }] }
}

export function takeIds(pool: Ids[]): [Ids | undefined, Ids[]] {
  const [first, ...rest] = pool
  return [first, rest]
}

export function patchEntry(queue: QueueEntry[], index: number, patch: Partial<QueueEntry>): QueueEntry[] {
  return queue.map((e, i) => (i === index ? { ...e, ...patch } : e))
}

export function withAgent(state: RoomState, agent: AgentState): RoomState {
  return { ...state, agents: { ...state.agents, [agent.id]: agent } }
}

export function withCall(state: RoomState, call: CallRecord): RoomState {
  return { ...state, calls: { ...state.calls, [call.agentId]: call } }
}

function withoutCall(state: RoomState, agentId: string): RoomState {
  const { [agentId]: _dropped, ...calls } = state.calls
  return { ...state, calls }
}

function withoutInvite(state: RoomState, agentId: string): RoomState {
  const { [agentId]: _dropped, ...invites } = state.invites
  return { ...state, invites }
}

// ─── Queue membership ────────────────────────────────────────────────────────

/** Removes a visitor from the queue, cancelling any invitation they held. */
export function removeVisitor(
  state: RoomState,
  visitorId: string,
  reason: Extract<VisitorStatus, 'left' | 'declined' | 'expired'>,
  now: number,
  commandId?: string
): Result {
  const entry = state.queue.find((e) => e.visitorId === visitorId)
  if (!entry) return rejectVisitor(state, visitorId, 'not_queued', "You're not in the line.", commandId)

  let next: RoomState = { ...state, queue: state.queue.filter((e) => e.visitorId !== visitorId) }
  const effects: Effect[] = [
    { k: 'db', op: { t: 'queue_session_status', id: entry.id, status: reason, at: now } },
    { k: 'send_agents', message: serverMsg('VISITOR_LEFT', { visitorId, reason }, now) },
    { k: 'analytics', name: 'queue_left', siteId: entry.siteId, visitorId, agentId: entry.assignedTo, props: { reason } }
  ]

  // "Visitor leaves exactly as the agent accepts" — if the person walking away is
  // the one holding an invitation, the invitation and its provisional call go
  // with them, and the agent is freed to take the next person.
  const inv = inviteFor(state, visitorId)
  if (inv) {
    const cleared = clearInvite(next, inv.agentId, reason, now)
    next = cleared.state
    effects.push(...cleared.effects)
  }

  effects.push({
    k: 'send_visitor',
    visitorId,
    message: serverMsg('SELF_UPDATE', { visitorId, queueEntryId: entry.id, status: reason, position: null, invite: null }, now)
  })
  return { state: next, effects }
}

// ─── Invitations ─────────────────────────────────────────────────────────────

export function invite(
  state: RoomState,
  agentId: string,
  visitorId: string,
  now: number,
  ids: Ids,
  settings: RoomSettings,
  commandId: string
): Result {
  const agent = state.agents[agentId]
  if (!agent || agent.intent === 'offline') {
    return rejectAgent(state, agentId, 'host_offline', 'Go live before accepting someone.', commandId)
  }
  // Two dashboard tabs pressing ACCEPT at the same moment: the first creates the
  // invite, the second lands here. The Durable Object serializes them, so this is
  // a plain check rather than a lock.
  if (state.calls[agentId] || state.invites[agentId]) {
    return rejectAgent(state, agentId, 'call_in_progress', 'Finish your current call first.', commandId)
  }

  const index = state.queue.findIndex((e) => e.visitorId === visitorId)
  const entry = index >= 0 ? state.queue[index] : undefined
  if (!entry) return rejectAgent(state, agentId, 'nothing_to_accept', 'That person has left the line.', commandId)
  if (entry.status === 'invited') {
    return rejectAgent(state, agentId, 'call_in_progress', 'Another agent is already inviting them.', commandId)
  }

  const expiresAt = now + settings.inviteTimeoutSeconds * 1000
  const call: CallRecord = {
    callId: ids.callId,
    callSecret: ids.callSecret,
    agentId,
    agentName: agent.name,
    visitorId: entry.visitorId,
    queueEntryId: entry.id,
    firstName: entry.firstName,
    siteId: entry.siteId,
    pageUrl: entry.pageUrl,
    question: entry.question,
    email: entry.email,
    company: entry.company,
    pageTitle: entry.pageTitle,
    referrer: entry.referrer,
    joinedAt: entry.joinedAt,
    meetingId: null,
    status: 'provisioning',
    startedAt: now,
    acceptedAt: null,
    connectedAt: null,
    hostPresent: false,
    visitorPresent: false,
    hostLeftAt: null,
    visitorLeftAt: null
  }

  let next: RoomState = {
    ...state,
    // The entry stays where it is, flagged invited, so people behind keep a
    // stable position until the call actually starts.
    queue: patchEntry(state.queue, index, { status: 'invited', assignedTo: agentId }),
    invites: { ...state.invites, [agentId]: { agentId, visitorId: entry.visitorId, queueEntryId: entry.id, callId: ids.callId, issuedAt: now, expiresAt } }
  }
  next = withCall(next, call)
  // Advance the round-robin cursor.
  next = withAgent(next, { ...agent, lastAssignedAt: now })

  return {
    state: next,
    effects: [
      // Provisioning starts now rather than when the visitor clicks, so the media
      // room is already waiting by the time they finish the AV check.
      { k: 'provision_call', callId: ids.callId, agentId, agentName: agent.name, visitorId: entry.visitorId, firstName: entry.firstName },
      { k: 'db', op: { t: 'queue_session_status', id: entry.id, status: 'invited', at: now, agentId } },
      {
        k: 'send_visitor',
        visitorId: entry.visitorId,
        message: serverMsg('CALL_INVITATION', { callId: ids.callId, callSecret: ids.callSecret, expiresAt, agentName: agent.name }, now)
      },
      { k: 'analytics', name: 'call_invited', siteId: entry.siteId, visitorId: entry.visitorId, agentId }
    ]
  }
}

/**
 * Tears down an agent's outstanding invitation and its provisional call because
 * of something the VISITOR did (or failed to do). They lose their place — the
 * spec is explicit that expired and declined invitations are not re-queued, so
 * the line stays honest for everyone who did stay at their keyboard.
 */
export function clearInvite(
  state: RoomState,
  agentId: string,
  reason: Extract<VisitorStatus, 'expired' | 'declined' | 'left'>,
  now: number
): Result {
  const inv = state.invites[agentId]
  if (!inv) return { state, effects: [] }
  const call = state.calls[agentId]

  let next = withoutInvite(withoutCall(state, agentId), agentId)
  next = { ...next, queue: next.queue.filter((e) => e.visitorId !== inv.visitorId) }

  const effects: Effect[] = [
    { k: 'db', op: { t: 'queue_session_status', id: inv.queueEntryId, status: reason, at: now, agentId } },
    { k: 'send_visitor', visitorId: inv.visitorId, message: serverMsg('CALL_INVITATION_EXPIRED', { callId: inv.callId }, now) },
    {
      k: 'send_visitor',
      visitorId: inv.visitorId,
      message: serverMsg('SELF_UPDATE', { visitorId: inv.visitorId, queueEntryId: inv.queueEntryId, status: reason, position: null, invite: null }, now)
    },
    { k: 'send_agents', message: serverMsg('VISITOR_LEFT', { visitorId: inv.visitorId, reason }, now) },
    {
      k: 'analytics',
      name: reason === 'declined' ? 'call_invite_declined' : 'call_invite_expired',
      siteId: call?.siteId ?? null,
      visitorId: inv.visitorId,
      agentId
    }
  ]
  if (call) effects.push({ k: 'release_call', callId: call.callId, meetingId: call.meetingId })
  return { state: next, effects }
}

/**
 * Tears down an agent's invitation because of something WE or the AGENT did
 * (provisioning failed, agent went offline). The visitor keeps their place at
 * exactly the same position, back in 'waiting', so another agent can take them.
 */
export function restoreVisitor(state: RoomState, agentId: string, now: number, settings: RoomSettings): Result {
  const inv = state.invites[agentId]
  const call = state.calls[agentId]
  let next = withoutInvite(withoutCall(state, agentId), agentId)
  const effects: Effect[] = []

  const visitorId = inv?.visitorId ?? call?.visitorId
  if (!visitorId) return { state: next, effects }
  if (call) effects.push({ k: 'release_call', callId: call.callId, meetingId: call.meetingId })

  const index = next.queue.findIndex((e) => e.visitorId === visitorId)
  if (index >= 0) {
    next = { ...next, queue: patchEntry(next.queue, index, { status: 'waiting', assignedTo: null }) }
  } else if (call) {
    // The visitor had already accepted and left the queue; put them back at the
    // head, since they were about to be served.
    const entry: QueueEntry = {
      id: call.queueEntryId,
      visitorId: call.visitorId,
      firstName: call.firstName,
      email: call.email ?? null,
      company: call.company ?? null,
      question: call.question,
      siteId: call.siteId,
      pageUrl: call.pageUrl,
      pageTitle: call.pageTitle ?? null,
      referrer: call.referrer ?? null,
      // The `??` guards cover call records persisted before these fields existed.
      joinedAt: call.joinedAt ?? now,
      status: 'waiting',
      assignedTo: null,
      connected: true,
      disconnectedAt: null
    }
    next = { ...next, queue: [entry, ...next.queue] }
  }
  if (inv) {
    effects.push({ k: 'send_visitor', visitorId, message: serverMsg('CALL_INVITATION_EXPIRED', { callId: inv.callId }, now) })
  }
  effects.push({ k: 'send_visitor', visitorId, message: serverMsg('SELF_UPDATE', selfView(next, visitorId, settings, now), now) })
  effects.push({ k: 'db', op: { t: 'queue_session_status', id: inv?.queueEntryId ?? call?.queueEntryId ?? '', status: 'waiting', at: now } })
  return { state: next, effects }
}

// ─── Calls ───────────────────────────────────────────────────────────────────

export function endCall(state: RoomState, agentId: string, now: number, reason: CallEndReason): Result {
  const call = state.calls[agentId]
  if (!call) return { state, effects: [] }

  // A call that never connected contributes nothing to the wait estimate — it
  // would otherwise drag the average toward zero and under-promise every wait.
  const connected = call.connectedAt !== null
  const durationSeconds = connected ? Math.max(0, Math.round((now - (call.connectedAt as number)) / 1000)) : 0

  let next = withoutInvite(withoutCall(state, agentId), agentId)
  next = {
    ...next,
    queue: next.queue.filter((e) => e.visitorId !== call.visitorId),
    recentDurations: connected ? [...next.recentDurations, durationSeconds].slice(-50) : next.recentDurations
  }

  const effects: Effect[] = [
    { k: 'broadcast', message: serverMsg('CALL_ENDED', { callId: call.callId, agentId, reason, durationSeconds }, now) },
    { k: 'db', op: { t: 'call_end', callId: call.callId, at: now, durationSeconds, reason } },
    { k: 'db', op: { t: 'queue_session_status', id: call.queueEntryId, status: 'completed', at: now, agentId } },
    { k: 'release_call', callId: call.callId, meetingId: call.meetingId },
    {
      k: 'send_visitor',
      visitorId: call.visitorId,
      message: serverMsg('SELF_UPDATE', { visitorId: call.visitorId, queueEntryId: call.queueEntryId, status: 'completed', position: null, invite: null }, now)
    },
    { k: 'analytics', name: 'call_completed', siteId: call.siteId, visitorId: call.visitorId, agentId, props: { reason, durationSeconds } }
  ]
  return { state: next, effects }
}

// ─── Agents ──────────────────────────────────────────────────────────────────

/**
 * One agent going offline for real — by choice, or because the grace window
 * after their dashboard closed ran out. Their call ends; a visitor they were
 * inviting goes back to waiting for someone else. Only when the LAST agent
 * leaves is the queue itself released.
 */
export function agentOffline(state: RoomState, agentId: string, now: number, settingsForRestore: RoomSettings): Result {
  const agent = state.agents[agentId]
  if (!agent) return { state, effects: [] }
  let next = state
  const effects: Effect[] = []

  const call = next.calls[agentId]
  if (call && call.status === 'in_call') {
    // A conversation that was actually happening ends.
    const ended = endCall(next, agentId, now, 'host_offline')
    next = ended.state
    effects.push(...ended.effects)
  } else if (call || next.invites[agentId]) {
    // An invitation, or a call the visitor accepted but that never connected:
    // nothing happened yet, so the visitor goes back to the front for the next
    // agent rather than being told their call is over.
    const restored = restoreVisitor(next, agentId, now, settingsForRestore)
    next = restored.state
    effects.push(...restored.effects)
  }

  next = withAgent(next, { ...agent, intent: 'offline', liveSince: null, disconnectedAt: null })

  // Everyone still in line is told plainly, then released — but only if nobody
  // is left to serve them. Holding people in a queue that cannot move is worse
  // than telling them to leave a message.
  if (liveAgents(next).length === 0) {
    for (const entry of next.queue) {
      effects.push({ k: 'db', op: { t: 'queue_session_status', id: entry.id, status: 'expired', at: now } })
      effects.push({
        k: 'send_visitor',
        visitorId: entry.visitorId,
        message: serverMsg('SELF_UPDATE', { visitorId: entry.visitorId, queueEntryId: entry.id, status: 'expired', position: null, invite: null }, now)
      })
    }
    next = { ...next, queue: [] }
  }
  return { state: next, effects }
}

// ─── Assignment and time ─────────────────────────────────────────────────────

/**
 * Round-robin. Hands each waiting visitor, in queue order, to the free agent
 * who was handed somebody longest ago, until one side runs out. Only in `auto`
 * mode; in `manual` mode agents press Accept.
 *
 * Called after anything that could free an agent or add a visitor, with a pool
 * of fresh ids to spend. If the pool runs out the loop stops — the next event
 * picks up where it left off.
 */
export function assign(state: RoomState, now: number, pool: Ids[], settings: RoomSettings, effects: Effect[]): Result {
  if (state.assignment !== 'auto') return { state, effects }
  if (state.provisionHoldUntil !== null && now < state.provisionHoldUntil) return { state, effects }
  let next = state
  let ids = pool
  const out = [...effects]

  for (;;) {
    const visitor = next.queue.find((e) => e.status === 'waiting')
    const agent = availableAgents(next)[0]
    if (!visitor || !agent) break
    const [current, rest] = takeIds(ids)
    if (!current) break
    ids = rest
    const invited = invite(next, agent.id, visitor.visitorId, now, current, settings, `auto_${current.callId}`)
    if (invited.state === next) break
    next = invited.state
    out.push(...invited.effects)
  }
  return { state: next, effects: out }
}

/**
 * Applies every deadline that has passed. Written as a loop over independent
 * checks rather than "the one thing the alarm was set for", because a Durable
 * Object alarm can fire late, fire once for several overlapping deadlines, or
 * fire after a restart that lost track of why it was armed.
 */
export function tick(state: RoomState, now: number, ids: Ids[], settings: RoomSettings): Result {
  let next = state
  const effects: Effect[] = []

  // 1. Agents whose dashboard has been gone longer than the grace window.
  for (const agent of Object.values(next.agents)) {
    if (agent.intent !== 'offline' && agent.connections === 0 && agent.disconnectedAt !== null &&
        now >= agent.disconnectedAt + settings.hostDisconnectGraceSeconds * 1000) {
      const offline = agentOffline(next, agent.id, now, settings)
      next = offline.state
      effects.push(...offline.effects)
    }
  }

  // 2. Invitations that timed out.
  for (const inv of Object.values(next.invites)) {
    if (now >= inv.expiresAt) {
      const expired = clearInvite(next, inv.agentId, 'expired', now)
      next = expired.state
      effects.push(...expired.effects)
    }
  }

  // 3. Waiting visitors whose tab never came back. Anyone holding an invitation
  //    is governed by that invitation's deadline instead.
  const evicted = next.queue.filter(
    (e) => e.status === 'waiting' && !e.connected && e.disconnectedAt !== null &&
      now >= e.disconnectedAt + settings.visitorDisconnectGraceSeconds * 1000
  )
  if (evicted.length > 0) {
    const gone = new Set(evicted.map((e) => e.visitorId))
    next = { ...next, queue: next.queue.filter((e) => !gone.has(e.visitorId)) }
    for (const entry of evicted) {
      effects.push({ k: 'db', op: { t: 'queue_session_status', id: entry.id, status: 'expired', at: now } })
      effects.push({ k: 'send_agents', message: serverMsg('VISITOR_LEFT', { visitorId: entry.visitorId, reason: 'expired' }, now) })
      effects.push({ k: 'analytics', name: 'queue_left', siteId: entry.siteId, visitorId: entry.visitorId, agentId: null, props: { reason: 'disconnect_timeout' } })
    }
  }

  // 4. Calls where one side has been gone too long, or never arrived.
  for (const call of Object.values(next.calls)) {
    if (call.status === 'in_call') {
      const limit = settings.activeCallReconnectSeconds * 1000
      const hostGone = call.hostLeftAt !== null && now >= call.hostLeftAt + limit
      const visitorGone = call.visitorLeftAt !== null && now >= call.visitorLeftAt + limit
      if (hostGone || visitorGone) {
        const ended = endCall(next, call.agentId, now, hostGone ? 'host_timeout' : 'visitor_timeout')
        next = ended.state
        effects.push(...ended.effects)
      }
    } else if (call.acceptedAt !== null && now >= call.acceptedAt + settings.callConnectTimeoutSeconds * 1000) {
      const ended = endCall(next, call.agentId, now, 'connect_timeout')
      next = ended.state
      effects.push(...ended.effects)
    }
  }

  // Anything above may have freed an agent.
  return assign(next, now, ids, settings, effects)
}

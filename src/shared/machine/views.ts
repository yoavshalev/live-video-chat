/**
 * Read-only projections of the room state: what a widget, a waiting visitor or
 * a dashboard is told, plus the one number the alarm needs. Pure functions of
 * (state, settings, now); nothing here changes state.
 */

import type {
  ActiveCallView,
  AgentView,
  HostStatus,
  PresenceView,
  QueueEntryView,
  QueuePositionView,
  SelfView,
  VisitorStatus
} from '../protocol'
import type { RoomSettings } from '../../config'
import type { AgentState, CallRecord, Invite, QueueEntry, RoomState } from './types'

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function inviteFor(s: RoomState, visitorId: string): Invite | undefined {
  return Object.values(s.invites).find((i) => i.visitorId === visitorId)
}

export function callFor(s: RoomState, visitorId: string): CallRecord | undefined {
  return Object.values(s.calls).find((c) => c.visitorId === visitorId)
}

export function callById(s: RoomState, callId: string): CallRecord | undefined {
  return Object.values(s.calls).find((c) => c.callId === callId)
}

export function liveAgents(s: RoomState): AgentState[] {
  return Object.values(s.agents).filter((a) => a.intent !== 'offline')
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Precedence matters and is not arbitrary: the visitor most needs to know they
 * cannot be served (offline), then that they will have to wait (busy), then
 * that the host has stopped taking people (paused).
 */
export function agentStatus(s: RoomState, agentId: string): HostStatus {
  const agent = s.agents[agentId]
  if (!agent || agent.intent === 'offline') return 'offline'
  if (s.calls[agentId] || s.invites[agentId]) return 'busy'
  if (agent.intent === 'paused') return 'paused'
  return 'available'
}

/** Agents who could take a visitor right now, in round-robin order. */
export function availableAgents(s: RoomState): AgentState[] {
  return Object.values(s.agents)
    .filter((a) => a.intent === 'live' && a.connections > 0 && !s.invites[a.id] && !s.calls[a.id])
    .sort((a, b) => a.lastAssignedAt - b.lastAssignedAt || a.id.localeCompare(b.id))
}

/**
 * The organization's status is the best any agent can offer: one available
 * agent makes the whole org available, however busy the rest are.
 */
export function deriveStatus(s: RoomState): HostStatus {
  const live = liveAgents(s)
  if (live.length === 0) return 'offline'
  const statuses = live.map((a) => agentStatus(s, a.id))
  if (statuses.includes('available')) return 'available'
  if (statuses.includes('busy')) return 'busy'
  return 'paused'
}

export function averageCallSeconds(s: RoomState, settings: RoomSettings): number | null {
  if (s.recentDurations.length < settings.minCallsForEstimate) return null
  const window = s.recentDurations.slice(-settings.estimateWindow)
  const total = window.reduce((sum, d) => sum + d, 0)
  return Math.round(total / window.length)
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function presenceView(s: RoomState, settings: RoomSettings): PresenceView {
  const live = liveAgents(s)
  const since = live.reduce<number | null>((min, a) => (a.liveSince !== null && (min === null || a.liveSince < min) ? a.liveSince : min), null)
  return {
    hostId: s.orgId,
    status: deriveStatus(s),
    queueLength: s.queue.length,
    liveSince: since,
    agentsLive: live.length,
    averageCallSeconds: averageCallSeconds(s, settings)
  }
}

export function agentView(s: RoomState, agent: AgentState): AgentView {
  const call = s.calls[agent.id]
  const invite = s.invites[agent.id]
  const invitedEntry = invite ? s.queue.find((e) => e.visitorId === invite.visitorId) : undefined
  return {
    id: agent.id,
    name: agent.name,
    status: agentStatus(s, agent.id),
    connected: agent.connections > 0,
    liveSince: agent.liveSince,
    callWith: call?.firstName ?? invitedEntry?.firstName ?? null
  }
}

export function agentViews(s: RoomState): AgentView[] {
  return Object.values(s.agents)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => agentView(s, a))
}

export function queueEntryView(e: QueueEntry): QueueEntryView {
  return {
    id: e.id,
    visitorId: e.visitorId,
    firstName: e.firstName,
    email: e.email,
    company: e.company,
    question: e.question,
    siteId: e.siteId,
    pageUrl: e.pageUrl,
    pageTitle: e.pageTitle,
    referrer: e.referrer,
    joinedAt: e.joinedAt,
    status: e.status,
    assignedTo: e.assignedTo,
    connected: e.connected
  }
}

export function activeCallView(c: CallRecord): ActiveCallView {
  return {
    callId: c.callId,
    agentId: c.agentId,
    agentName: c.agentName,
    visitorId: c.visitorId,
    firstName: c.firstName,
    siteId: c.siteId,
    pageUrl: c.pageUrl,
    question: c.question,
    startedAt: c.startedAt,
    connectedAt: c.connectedAt,
    status: c.status,
    hostPresent: c.hostPresent,
    visitorPresent: c.visitorPresent
  }
}

export function activeCallViews(s: RoomState): ActiveCallView[] {
  return Object.values(s.calls).map(activeCallView)
}

/**
 * The estimate assumes the live agents work in parallel — with two agents, the
 * third person in line waits about one call, not two — and adds the remainder
 * of the call that will free up soonest when nobody is free at all. Without
 * that last part the person at position 1 is told "~0 min" while every agent is
 * eight minutes into a conversation, which is the one case where being wrong is
 * most visible.
 */
export function positionView(
  s: RoomState,
  visitorId: string,
  settings: RoomSettings,
  now: number
): QueuePositionView | null {
  const index = s.queue.findIndex((e) => e.visitorId === visitorId)
  if (index < 0) return null
  const entry = s.queue[index]
  if (!entry) return null

  const average = averageCallSeconds(s, settings)
  let estimate: number | null = null
  if (average !== null) {
    const serving = Math.max(1, liveAgents(s).filter((a) => a.intent === 'live').length)
    let seconds = Math.round((index * average) / serving)
    if (availableAgents(s).length === 0) {
      const remainders = Object.values(s.calls)
        .filter((c) => c.visitorId !== visitorId)
        .map((c) => Math.max(0, average - Math.max(0, Math.round((now - (c.connectedAt ?? c.startedAt)) / 1000))))
      if (remainders.length > 0) seconds += Math.min(...remainders)
    }
    estimate = seconds
  }

  return { queueEntryId: entry.id, position: index + 1, peopleAhead: index, estimatedWaitSeconds: estimate }
}

export function selfView(s: RoomState, visitorId: string, settings: RoomSettings, now: number): SelfView {
  const entry = s.queue.find((e) => e.visitorId === visitorId)
  const call = callFor(s, visitorId)
  const invite = inviteFor(s, visitorId)

  // Order matters: a provisional call is created the instant the host accepts,
  // but the visitor is only 'connecting' once they have accepted in return. The
  // outstanding invitation therefore outranks the call it belongs to.
  let status: VisitorStatus = 'browsing'
  if (invite) status = 'invited'
  else if (call) status = call.status === 'in_call' ? 'in_call' : 'connecting'
  else if (entry) status = entry.status === 'invited' ? 'invited' : 'waiting'

  return {
    visitorId,
    queueEntryId: entry?.id ?? call?.queueEntryId ?? null,
    status,
    position: positionView(s, visitorId, settings, now),
    invite:
      invite && call
        ? { callId: invite.callId, callSecret: call.callSecret, expiresAt: invite.expiresAt, agentName: call.agentName }
        : null
  }
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

/**
 * The single alarm timestamp the Durable Object should arm, or null for "no
 * pending deadlines". A Durable Object has exactly one alarm slot, so every
 * timeout in the product has to collapse into this one number and TICK has to
 * be able to apply all of them at once.
 */
export function nextDeadline(s: RoomState, settings: RoomSettings): number | null {
  const candidates: number[] = []

  for (const invite of Object.values(s.invites)) candidates.push(invite.expiresAt)

  // The end of a provisioning hold is only worth waking up for if it would
  // actually assign someone.
  if (s.provisionHoldUntil !== null && s.assignment === 'auto' && s.queue.some((e) => e.status === 'waiting')) {
    candidates.push(s.provisionHoldUntil)
  }

  for (const agent of Object.values(s.agents)) {
    if (agent.intent !== 'offline' && agent.connections === 0 && agent.disconnectedAt !== null) {
      candidates.push(agent.disconnectedAt + settings.hostDisconnectGraceSeconds * 1000)
    }
  }

  for (const entry of s.queue) {
    if (!entry.connected && entry.disconnectedAt !== null) {
      candidates.push(entry.disconnectedAt + settings.visitorDisconnectGraceSeconds * 1000)
    }
  }

  for (const call of Object.values(s.calls)) {
    if (call.status === 'in_call') {
      if (call.hostLeftAt !== null) candidates.push(call.hostLeftAt + settings.activeCallReconnectSeconds * 1000)
      if (call.visitorLeftAt !== null) candidates.push(call.visitorLeftAt + settings.activeCallReconnectSeconds * 1000)
    } else if (call.acceptedAt !== null) {
      candidates.push(call.acceptedAt + settings.callConnectTimeoutSeconds * 1000)
    }
  }

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

/**
 * The queue/presence state machine, as a pure reducer.
 *
 * WHY THIS IS NOT INSIDE THE DURABLE OBJECT
 * -----------------------------------------
 * Everything here is `(state, command) -> { state, effects }` with no I/O, no
 * clock and no randomness: `now` and every generated id arrive on the command.
 * That buys two things. Tests (test/machine.test.ts) drive the entire product
 * lifecycle in-process in milliseconds. And the Durable Object is reduced to a
 * shell that persists, broadcasts and sets alarms — the part that is hard to get
 * right is the part that is easy to test.
 *
 * SHAPE: one organization, N agents, ONE shared FIFO queue. Each agent has their
 * own live/offline switch, at most one outstanding invitation and at most one
 * call. Visitors are handed to agents round-robin: the free agent who was handed
 * a visitor longest ago goes next.
 *
 * INVARIANTS the reducer maintains, and which the tests pin down:
 *   - An agent has at most one invite and at most one call at any moment.
 *   - A visitorId appears at most once across `queue` and all `calls`.
 *   - `queue` is strict FIFO by `joinedAt`; an invited entry keeps its place
 *     until the call actually starts, so people behind see a stable position.
 *   - Every command carrying a `commandId` is applied at most once, so a retry
 *     after a dropped socket can never double-accept or double-end.
 */

import type {
  ActiveCallView,
  AgentView,
  AssignmentMode,
  CallEndReason,
  ErrorCode,
  HostStatus,
  PresenceView,
  QueueEntryView,
  QueuePositionView,
  SelfView,
  ServerMessage,
  VisitorStatus
} from './protocol'
import { serverMsg } from './protocol'
import type { RoomSettings } from '../config'

// ─── State ───────────────────────────────────────────────────────────────────

export interface QueueEntry {
  /** queue_sessions.id — the durable record of this person's turn in line. */
  id: string
  visitorId: string
  firstName: string
  email: string | null
  company: string | null
  question: string | null
  siteId: string
  pageUrl: string
  pageTitle: string | null
  referrer: string | null
  joinedAt: number
  status: 'waiting' | 'invited'
  /** The agent inviting them, while status is 'invited'. */
  assignedTo: string | null
  /** Live socket present. False during the disconnect grace window. */
  connected: boolean
  /** When the last socket for this visitor closed; drives grace eviction. */
  disconnectedAt: number | null
}

export interface AgentState {
  id: string
  name: string
  /** What the agent last asked for. Status is derived from it plus reality. */
  intent: 'offline' | 'live' | 'paused'
  connections: number
  disconnectedAt: number | null
  liveSince: number | null
  /** The round-robin cursor: when this agent was last handed a visitor. 0 = never. */
  lastAssignedAt: number
}

export interface Invite {
  agentId: string
  visitorId: string
  queueEntryId: string
  callId: string
  issuedAt: number
  expiresAt: number
}

export interface CallRecord {
  callId: string
  /** Bearer secret the call page trades for RealtimeKit credentials. Never broadcast. */
  callSecret: string
  agentId: string
  agentName: string
  visitorId: string
  queueEntryId: string
  firstName: string
  siteId: string
  pageUrl: string
  question: string | null
  /** Null until the RealtimeKit meeting has been created. */
  meetingId: string | null
  status: 'provisioning' | 'connecting' | 'in_call'
  /** When the agent accepted (or was assigned). The invite countdown runs from here. */
  startedAt: number
  /** When the visitor accepted the invitation; starts the connect timeout. */
  acceptedAt: number | null
  /** When both sides were actually in the media room. Metrics use this. */
  connectedAt: number | null
  hostPresent: boolean
  visitorPresent: boolean
  hostLeftAt: number | null
  visitorLeftAt: number | null
}

export interface RoomState {
  /** Shape version. The DO discards a persisted state of any other shape. */
  version: 2
  orgId: string
  agents: Record<string, AgentState>
  queue: QueueEntry[]
  /** Keyed by agentId. */
  invites: Record<string, Invite>
  /** Keyed by agentId. */
  calls: Record<string, CallRecord>
  /** Durations in seconds of recently *connected* calls; drives the wait estimate. */
  recentDurations: number[]
  assignment: AssignmentMode
  /**
   * Until when automatic assignment is paused after a provisioning failure.
   * A failure to create a meeting is a system failure, not a visitor's, and
   * re-inviting immediately is a hot loop against a broken dependency — it
   * once took a Worker down. Manual accepts are unaffected. Null when clear.
   */
  provisionHoldUntil: number | null
  /** Ring buffer of applied commandIds — the idempotency guard. */
  recentCommandIds: string[]
}

export function initialState(orgId: string, assignment: AssignmentMode = 'auto'): RoomState {
  return {
    version: 2,
    orgId,
    agents: {},
    queue: [],
    invites: {},
    calls: {},
    recentDurations: [],
    assignment,
    provisionHoldUntil: null,
    recentCommandIds: []
  }
}

/** True if a persisted blob is a state this reducer understands. */
export function isCurrentState(value: unknown): value is RoomState {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 2
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** Fresh ids the reducer may consume. Generated by the caller; the reducer stays pure. */
export interface Ids {
  queueEntryId: string
  callId: string
  callSecret: string
}

export type Command =
  /** `connections` is the true socket count when the caller knows it; otherwise one is added. */
  | { t: 'HOST_CONNECT'; now: number; agentId: string; name: string; connections?: number }
  | { t: 'HOST_DISCONNECT'; now: number; agentId: string; remaining: number }
  | { t: 'HOST_GO_LIVE'; now: number; commandId: string; agentId: string; ids: Ids[] }
  | { t: 'HOST_GO_OFFLINE'; now: number; commandId: string; agentId: string; ids: Ids[] }
  | { t: 'HOST_PAUSE'; now: number; commandId: string; agentId: string }
  | { t: 'HOST_RESUME'; now: number; commandId: string; agentId: string; ids: Ids[] }
  | { t: 'HOST_SET_ASSIGNMENT'; now: number; commandId: string; mode: AssignmentMode; ids: Ids[] }
  | { t: 'VISITOR_CONNECT'; now: number; visitorId: string }
  | { t: 'VISITOR_DISCONNECT'; now: number; visitorId: string; remaining: number }
  | {
      t: 'QUEUE_JOIN'
      now: number
      commandId: string
      visitorId: string
      queueEntryId: string
      firstName: string
      email: string | null
      company: string | null
      question: string | null
      siteId: string
      pageUrl: string
      pageTitle: string | null
      referrer: string | null
      ids: Ids[]
    }
  | { t: 'QUEUE_LEAVE'; now: number; commandId: string; visitorId: string; ids: Ids[] }
  | { t: 'ACCEPT_NEXT'; now: number; commandId: string; agentId: string; ids: Ids[] }
  | { t: 'ACCEPT_VISITOR'; now: number; commandId: string; agentId: string; visitorId: string; ids: Ids[] }
  | { t: 'DECLINE_VISITOR'; now: number; commandId: string; agentId: string; visitorId: string; ids: Ids[] }
  | { t: 'VISITOR_ACCEPT_INVITE'; now: number; commandId: string; visitorId: string }
  | { t: 'VISITOR_DECLINE_INVITE'; now: number; commandId: string; visitorId: string; ids: Ids[] }
  | { t: 'CALL_PROVISIONED'; now: number; callId: string; meetingId: string }
  | { t: 'CALL_PROVISION_FAILED'; now: number; callId: string; error: string; ids: Ids[] }
  | { t: 'MEDIA_JOINED'; now: number; callId: string; who: 'host' | 'visitor' }
  | { t: 'MEDIA_LEFT'; now: number; callId: string; who: 'host' | 'visitor' }
  | { t: 'CALL_END'; now: number; commandId: string; callId: string; reason: CallEndReason; ids: Ids[] }
  /** Alarm. Applies every deadline that has passed; safe to call at any time. */
  | { t: 'TICK'; now: number; ids: Ids[] }

// ─── Effects ─────────────────────────────────────────────────────────────────

export type DbOp =
  | { t: 'queue_session_insert'; entry: QueueEntry }
  | { t: 'queue_session_status'; id: string; status: VisitorStatus; at: number; agentId?: string }
  | {
      t: 'call_start'
      callId: string
      agentId: string
      visitorId: string
      queueEntryId: string
      siteId: string
      meetingId: string | null
      at: number
    }
  | { t: 'call_end'; callId: string; at: number; durationSeconds: number; reason: CallEndReason }

export type AnalyticsName =
  | 'queue_joined'
  | 'queue_left'
  | 'call_invited'
  | 'call_invite_accepted'
  | 'call_invite_declined'
  | 'call_invite_expired'
  | 'call_started'
  | 'call_completed'

export type Effect =
  | { k: 'send_visitor'; visitorId: string; message: ServerMessage }
  | { k: 'send_agent'; agentId: string; message: ServerMessage }
  /** Every agent's dashboard. */
  | { k: 'send_agents'; message: ServerMessage }
  /** Every socket: widgets, waiting visitors and dashboards. */
  | { k: 'broadcast'; message: ServerMessage }
  | { k: 'provision_call'; callId: string; agentId: string; agentName: string; visitorId: string; firstName: string }
  /** Best-effort RealtimeKit teardown. Never blocks a state transition. */
  | { k: 'release_call'; callId: string; meetingId: string | null }
  | { k: 'db'; op: DbOp }
  | {
      k: 'analytics'
      name: AnalyticsName
      siteId: string | null
      visitorId: string | null
      agentId: string | null
      props?: Record<string, unknown>
    }

export interface Result {
  state: RoomState
  effects: Effect[]
}

// ─── Derived views ───────────────────────────────────────────────────────────

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

function liveAgents(s: RoomState): AgentState[] {
  return Object.values(s.agents).filter((a) => a.intent !== 'offline')
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

function inviteFor(s: RoomState, visitorId: string): Invite | undefined {
  return Object.values(s.invites).find((i) => i.visitorId === visitorId)
}

function callFor(s: RoomState, visitorId: string): CallRecord | undefined {
  return Object.values(s.calls).find((c) => c.visitorId === visitorId)
}

function callById(s: RoomState, callId: string): CallRecord | undefined {
  return Object.values(s.calls).find((c) => c.callId === callId)
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

// ─── Reducer ─────────────────────────────────────────────────────────────────

const COMMAND_HISTORY = 64

function err(code: ErrorCode, message: string, commandId?: string): ServerMessage {
  return serverMsg('ERROR', { code, message, commandId })
}

function rejectVisitor(state: RoomState, visitorId: string, code: ErrorCode, message: string, commandId?: string): Result {
  return { state, effects: [{ k: 'send_visitor', visitorId, message: err(code, message, commandId) }] }
}

function rejectAgent(state: RoomState, agentId: string, code: ErrorCode, message: string, commandId?: string): Result {
  return { state, effects: [{ k: 'send_agent', agentId, message: err(code, message, commandId) }] }
}

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

function withAgent(state: RoomState, agent: AgentState): RoomState {
  return { ...state, agents: { ...state.agents, [agent.id]: agent } }
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
      if (!call) return { state, effects: [] }
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

// ─── Transition helpers ──────────────────────────────────────────────────────

function takeIds(pool: Ids[]): [Ids | undefined, Ids[]] {
  const [first, ...rest] = pool
  return [first, rest]
}

function patchEntry(queue: QueueEntry[], index: number, patch: Partial<QueueEntry>): QueueEntry[] {
  return queue.map((e, i) => (i === index ? { ...e, ...patch } : e))
}

function withCall(state: RoomState, call: CallRecord): RoomState {
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

/** Removes a visitor from the queue, cancelling any invitation they held. */
function removeVisitor(
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

function invite(
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
function clearInvite(
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
function restoreVisitor(state: RoomState, agentId: string, now: number, settings: RoomSettings): Result {
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
      email: null,
      company: null,
      question: call.question,
      siteId: call.siteId,
      pageUrl: call.pageUrl,
      pageTitle: null,
      referrer: null,
      joinedAt: now,
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

function endCall(state: RoomState, agentId: string, now: number, reason: CallEndReason): Result {
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

/**
 * One agent going offline for real — by choice, or because the grace window
 * after their dashboard closed ran out. Their call ends; a visitor they were
 * inviting goes back to waiting for someone else. Only when the LAST agent
 * leaves is the queue itself released.
 */
function agentOffline(state: RoomState, agentId: string, now: number, settingsForRestore: RoomSettings): Result {
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

/**
 * Round-robin. Hands each waiting visitor, in queue order, to the free agent
 * who was handed somebody longest ago, until one side runs out. Only in `auto`
 * mode; in `manual` mode agents press Accept.
 *
 * Called after anything that could free an agent or add a visitor, with a pool
 * of fresh ids to spend. If the pool runs out the loop stops — the next event
 * picks up where it left off.
 */
function assign(state: RoomState, now: number, pool: Ids[], settings: RoomSettings, effects: Effect[]): Result {
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
function tick(state: RoomState, now: number, ids: Ids[], settings: RoomSettings): Result {
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

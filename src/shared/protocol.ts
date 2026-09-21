/**
 * The WebSocket wire protocol, shared verbatim between the Worker, the Durable
 * Object and every browser bundle in client/. It is the single place where the
 * shape of a message is decided, which is why client/ imports straight out of
 * src/shared/ rather than keeping its own copy.
 *
 * Every message is `{ type, timestamp, payload }`. Inbound payloads are validated
 * in shared/validation.ts before they reach the state machine — nothing in here
 * may be trusted just because it type-checks at compile time.
 *
 * VOCABULARY: an *organization* is one deployment. It has *agents* — the people
 * who take calls, each with their own login and their own live/offline switch.
 * The dashboard side of the socket is still called the `host` role, because
 * from the visitor's point of view that is what it is; `agentId` on the
 * attachment says which agent is behind it.
 */

/** Status of one agent, and — by the same words — of the organization as a whole. */
export type HostStatus = 'offline' | 'available' | 'busy' | 'paused'

/**
 * The visitor's lifecycle. `browsing` has no server-side record; everything from
 * `waiting` onward corresponds to a row in queue_sessions.
 */
export type VisitorStatus =
  | 'browsing'
  | 'waiting'
  | 'invited'
  | 'av_setup'
  | 'connecting'
  | 'in_call'
  | 'completed'
  | 'left'
  | 'declined'
  | 'expired'

/**
 * How a socket identifies itself at /ws. `widget` is a page that is only
 * displaying presence; `waiting_visitor` is one that has a queue identity and
 * therefore receives targeted position and invitation messages; `host` is an
 * agent's dashboard.
 */
export type ClientRole = 'host' | 'widget' | 'waiting_visitor'

export type AgentRole = 'admin' | 'agent'

/** Who gets the next visitor: the system, round-robin, or an agent pressing Accept. */
export type AssignmentMode = 'auto' | 'manual'

export interface SocketAttachment {
  role: ClientRole
  visitorId?: string
  siteId?: string
  /** Set on host sockets, from the verified session — never from the client. */
  agentId?: string
  agentName?: string
  agentRole?: AgentRole
  /** Distinguishes two tabs belonging to the same person. */
  connId: string
  connectedAt: number
}

// ─── Public projections of server state ──────────────────────────────────────

/** What every widget is told. Deliberately says nothing about who is waiting. */
export interface PresenceView {
  hostId: string
  /** The organization's status: the best any agent can offer right now. */
  status: HostStatus
  queueLength: number
  liveSince: number | null
  /** How many agents are live (available, busy or paused). */
  agentsLive: number
  /** Seconds; rolling average of recent completed calls. Null until we have data. */
  averageCallSeconds: number | null
}

/** One agent, as every agent's dashboard sees them. */
export interface AgentView {
  id: string
  name: string
  status: HostStatus
  /** False while their dashboard is gone but still inside its grace window. */
  connected: boolean
  liveSince: number | null
  /** First name of the visitor they are inviting or talking to, if any. */
  callWith: string | null
}

/** What the dashboards are told about one person in line. */
export interface QueueEntryView {
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
  /** The agent this visitor is being invited by, while `status` is 'invited'. */
  assignedTo: string | null
  /** False while the tab is gone but still inside its grace window. */
  connected: boolean
}

/** What a waiting visitor is told about themselves. Never about anyone else. */
export interface QueuePositionView {
  queueEntryId: string
  /** 1-based. 1 means "you are next". */
  position: number
  peopleAhead: number
  /** Null when there are too few completed calls to estimate honestly. */
  estimatedWaitSeconds: number | null
}

export interface ActiveCallView {
  callId: string
  agentId: string
  agentName: string
  visitorId: string
  firstName: string
  siteId: string
  pageUrl: string
  question: string | null
  startedAt: number
  connectedAt: number | null
  status: 'provisioning' | 'connecting' | 'in_call'
  hostPresent: boolean
  visitorPresent: boolean
}

/** A visitor's own view of themselves — the basis for restoring state after a refresh. */
export interface SelfView {
  visitorId: string
  queueEntryId: string | null
  status: VisitorStatus
  position: QueuePositionView | null
  invite: { callId: string; callSecret: string; expiresAt: number; agentName: string } | null
}

export interface HostProfileView {
  displayName: string
  avatarUrl: string | null
  loopVideoUrl: string | null
  loopPosterUrl: string | null
  headline: string
  subheadline: string
}

export type CallEndReason =
  | 'host_ended'
  | 'visitor_left'
  | 'host_offline'
  | 'visitor_timeout'
  | 'host_timeout'
  | 'connect_timeout'
  | 'provision_failed'

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_payload'
  | 'rate_limited'
  | 'host_offline'
  | 'host_paused'
  | 'queue_full'
  | 'already_queued'
  | 'not_queued'
  | 'no_invite'
  | 'invite_expired'
  | 'nothing_to_accept'
  | 'call_in_progress'
  | 'no_active_call'
  | 'provision_failed'
  | 'internal'

// ─── Client → Server ─────────────────────────────────────────────────────────

interface Msg<T extends string, P> {
  type: T
  timestamp: number
  payload: P
}

export type QueueJoinPayload = {
  commandId: string
  firstName: string
  email?: string
  company?: string
  question?: string
  pageUrl: string
  pageTitle?: string
  referrer?: string
}

export type ClientMessage =
  // Agent controls. Each is rejected unless the socket authenticated as an agent —
  // the identity comes from the socket attachment, never from the payload.
  | Msg<'HOST_GO_LIVE', { commandId: string }>
  | Msg<'HOST_GO_OFFLINE', { commandId: string }>
  | Msg<'HOST_PAUSE', { commandId: string }>
  | Msg<'HOST_RESUME', { commandId: string }>
  /** Organization-wide. Any agent may change it; admins can restrict this later. */
  | Msg<'HOST_SET_ASSIGNMENT', { commandId: string; mode: AssignmentMode }>
  | Msg<'CALL_ACCEPT_NEXT', { commandId: string }>
  | Msg<'CALL_ACCEPT_VISITOR', { commandId: string; visitorId: string }>
  | Msg<'CALL_DECLINE_VISITOR', { commandId: string; visitorId: string }>
  | Msg<'CALL_END', { commandId: string; reason?: string }>
  // Visitor controls.
  | Msg<'QUEUE_JOIN', QueueJoinPayload>
  | Msg<'QUEUE_LEAVE', { commandId: string }>
  | Msg<'VISITOR_ACCEPT_INVITE', { commandId: string }>
  | Msg<'VISITOR_DECLINE_INVITE', { commandId: string }>
  // Sent by both sides once RealtimeKit reports the media room actually joined.
  | Msg<'CALL_MEDIA_JOINED', { commandId: string; callId: string }>
  | Msg<'CALL_MEDIA_LEFT', { commandId: string; callId: string }>
  | Msg<'HEARTBEAT', Record<string, never>>

// ─── Server → Client ─────────────────────────────────────────────────────────

export type ServerMessage =
  /** First message on every socket: the full snapshot this role is allowed to see. */
  | Msg<'HELLO', {
      role: ClientRole
      presence: PresenceView
      hostProfile: HostProfileView
      settings: { inviteTimeoutSeconds: number; assignment: AssignmentMode }
      /** Host sockets only: who you are. */
      me?: { agentId: string; name: string; role: AgentRole }
      queue?: QueueEntryView[]
      agents?: AgentView[]
      /** Every active call in the organization; a dashboard picks its own by agentId. */
      calls?: ActiveCallView[]
      self?: SelfView | null
    }>
  | Msg<'PRESENCE_UPDATE', PresenceView>
  | Msg<'QUEUE_UPDATE', { queue: QueueEntryView[]; agents: AgentView[]; calls: ActiveCallView[] }>
  | Msg<'QUEUE_POSITION_UPDATE', QueuePositionView>
  | Msg<'VISITOR_JOINED', { entry: QueueEntryView }>
  | Msg<'VISITOR_LEFT', { visitorId: string; reason: VisitorStatus }>
  /** Your turn. `callId`/`callSecret` are exchanged by the call page for media credentials. */
  | Msg<'CALL_INVITATION', { callId: string; callSecret: string; expiresAt: number; agentName: string }>
  | Msg<'CALL_INVITATION_EXPIRED', { callId: string }>
  | Msg<'CALL_CONNECTING', { callId: string; callSecret: string; visitorId: string; firstName: string; agentId: string; agentName: string }>
  | Msg<'CALL_STARTED', { callId: string; agentId: string; startedAt: number }>
  | Msg<'CALL_ENDED', { callId: string; agentId: string; reason: CallEndReason; durationSeconds: number }>
  /** Sent to a visitor whose own record changed for a reason they did not cause. */
  | Msg<'SELF_UPDATE', SelfView>
  | Msg<'ERROR', { code: ErrorCode; message: string; commandId?: string }>

export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>

/** Builds a Server→Client envelope. The DO never sends anything else. */
export function serverMsg<T extends ServerMessage['type']>(
  type: T,
  payload: ServerMessageOf<T>['payload'],
  now: number = Date.now()
): ServerMessage {
  return { type, timestamp: now, payload } as ServerMessage
}

/** Builds a Client→Server envelope. Used by the three browser bundles. */
export function clientMsg<T extends ClientMessage['type']>(
  type: T,
  payload: Extract<ClientMessage, { type: T }>['payload'],
  now: number = Date.now()
): ClientMessage {
  return { type, timestamp: now, payload } as ClientMessage
}

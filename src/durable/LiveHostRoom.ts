/**
 * LiveHostRoom — the one authoritative coordinator for an organization.
 *
 * There is exactly one instance per deployment (`idFromName(ORG_ID)`). Every
 * widget socket, every waiting visitor and every agent's dashboard connect here,
 * which is what makes a single FIFO queue shared across unrelated websites and
 * several agents possible at all: a Durable Object is the only place a single
 * serialized answer to "who is next, and whose turn is it to take them" can live.
 *
 * This class is deliberately a shell. All decisions are made by the pure reducer
 * in src/shared/machine; what happens here is I/O:
 *   - persist state after every command
 *   - decide who needs to be told what changed (./signatures.ts)
 *   - schedule the single alarm that drives every timeout
 *   - talk to RealtimeKit and D1
 * Messages become commands in ./commands.ts, which is pure and tested on its own.
 *
 * HIBERNATION: sockets are accepted with `ctx.acceptWebSocket`, not `ws.accept`,
 * so an idle room costs nothing while hundreds of widgets stay connected. Three
 * consequences shape the code below and none of them are optional:
 *   - No timers. `setInterval` would pin the object in memory forever; every
 *     deadline goes through `ctx.storage.setAlarm`.
 *   - No in-memory source of truth. The object can be evicted between any two
 *     messages, so state is read from storage and written back each time.
 *   - Socket identity lives in `serializeAttachment`, not a Map, because a Map
 *     does not survive eviction and a reconnecting visitor would lose their place.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { DEFAULT_SETTINGS, type RoomSettings } from '../config'
import {
  activeCallViews,
  agentViews,
  callFor,
  deriveStatus,
  initialState,
  isCurrentState,
  nextDeadline,
  positionView,
  presenceView,
  queueEntryView,
  reduce,
  selfView,
  type CallRecord,
  type Command,
  type Effect,
  type Ids,
  type RoomState
} from '../shared/machine'
import {
  serverMsg,
  type AgentRole,
  type ClientRole,
  type HostProfileView,
  type ServerMessage,
  type SocketAttachment
} from '../shared/protocol'
import { parseClientMessage } from '../shared/validation'
import { applyDbOp, getHostProfile, safeDb } from '../lib/db'
import { provisionCall, realtimeCredentials, releaseMeeting } from '../lib/realtimekit'
import { recordEvent } from '../lib/analytics'
import { randomId, randomSecret, timingSafeEqual } from '../lib/security'
import { commandFromMessage } from './commands'
import { dashboardSignature, orderSignature, presenceSignature } from './signatures'
import { tokensKey, type CallTokens, type RedeemResult } from './tokens'

export type { RedeemResult } from './tokens'

const STATE_KEY = 'room_state'

export class LiveHostRoom extends DurableObject<Env> {
  private profileCache: { value: HostProfileView; expires: number } | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalive frames are answered by the runtime without waking this object.
    // Without it, a heartbeat from every connected widget would defeat the entire
    // point of hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // ─── State plumbing ────────────────────────────────────────────────────────

  private async load(): Promise<RoomState> {
    const stored = await this.ctx.storage.get<unknown>(STATE_KEY)
    if (isCurrentState(stored)) return stored
    // Either nothing yet, or a state persisted by an older shape of the reducer.
    // Starting clean is the honest option: a queue from before the deploy holds
    // people the new code cannot reason about. Deploy this when nobody is live.
    if (stored !== undefined) console.warn('[room] discarding persisted state of an older shape')
    return initialState(this.env.ORG_ID, DEFAULT_SETTINGS.assignment)
  }

  private settings(): RoomSettings {
    return DEFAULT_SETTINGS
  }

  /**
   * A pool of fresh ids for one command. Round-robin can hand out several
   * invitations in a single step (two agents free, two people waiting), and the
   * reducer must stay pure, so it draws from a pool the shell prepared.
   */
  private idPool(size = 4): Ids[] {
    return Array.from({ length: size }, () => ({
      queueEntryId: randomId('qs'),
      callId: randomId('call'),
      // 256 bits. This is the bearer secret that lets one specific browser trade
      // up for media credentials, so guessing it must be hopeless.
      callSecret: randomSecret()
    }))
  }

  private async hostProfile(): Promise<HostProfileView> {
    const now = Date.now()
    if (this.profileCache && this.profileCache.expires > now) return this.profileCache.value
    const fallback: HostProfileView = {
      displayName: this.env.ORG_ID,
      avatarUrl: null,
      loopVideoUrl: null,
      loopPosterUrl: null,
      headline: 'Talk to us',
      subheadline: "Have a question? We're here right now."
    }
    let value = fallback
    try {
      value = (await getHostProfile(this.env, this.env.ORG_ID)) ?? fallback
    } catch (error) {
      console.error('[room] host profile read failed', error instanceof Error ? error.message : error)
    }
    this.profileCache = { value, expires: now + 60_000 }
    return value
  }

  // ─── Socket helpers ────────────────────────────────────────────────────────

  private attachmentOf(ws: WebSocket): SocketAttachment | null {
    try {
      return (ws.deserializeAttachment() as SocketAttachment | null) ?? null
    } catch {
      return null
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // A socket that died between our decision to send and the send itself is
      // routine. The close event will follow and clean up the state.
    }
  }

  private sendTo(tag: string, message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets(tag)) this.send(ws, message)
  }

  private sendAll(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, message)
  }

  private connectedVisitors(): Set<string> {
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets('role:visitor')) {
      const attachment = this.attachmentOf(ws)
      if (attachment?.visitorId) ids.add(attachment.visitorId)
    }
    return ids
  }

  /** The caller's own call, found from the socket's identity — never from a payload. */
  private async ownCall(attachment: SocketAttachment): Promise<CallRecord | undefined> {
    const state = await this.load()
    if (attachment.role === 'host' && attachment.agentId) return state.calls[attachment.agentId]
    if (attachment.visitorId) return callFor(state, attachment.visitorId)
    return undefined
  }

  // ─── The dispatch loop ─────────────────────────────────────────────────────

  /**
   * Applies one command and does everything that follows from it. Every mutation
   * in the system goes through here, which is why "two agents accept the same
   * visitor at once" is safe: a Durable Object handles one event at a time, so
   * the second ACCEPT genuinely observes the first one's result.
   */
  private async dispatch(command: Command): Promise<RoomState> {
    const before = await this.load()
    const settings = this.settings()
    const { state: after, effects } = reduce(before, command, settings)

    if (after !== before) await this.ctx.storage.put(STATE_KEY, after)

    // Targeted effects first: the person whose turn it is should hear about it
    // before the crowd does.
    for (const effect of effects) this.applyEffect(effect)

    const now = Date.now()
    if (presenceSignature(before, settings) !== presenceSignature(after, settings)) {
      this.sendAll(serverMsg('PRESENCE_UPDATE', presenceView(after, settings), now))
    }
    if (dashboardSignature(before) !== dashboardSignature(after)) {
      this.sendTo(
        'role:host',
        serverMsg('QUEUE_UPDATE', { queue: after.queue.map(queueEntryView), agents: agentViews(after), calls: activeCallViews(after) }, now)
      )
    }
    // Only when the *order* changes does everyone's position change. A visitor
    // reconnecting must not spam the whole line with position updates.
    if (orderSignature(before) !== orderSignature(after)) {
      for (const entry of after.queue) {
        const position = positionView(after, entry.visitorId, settings, now)
        if (position) this.sendTo(`v:${entry.visitorId}`, serverMsg('QUEUE_POSITION_UPDATE', position, now))
      }
    }

    await this.rearmAlarm(after)
    return after
  }

  private applyEffect(effect: Effect): void {
    switch (effect.k) {
      case 'send_visitor':
        this.sendTo(`v:${effect.visitorId}`, effect.message)
        return
      case 'send_agent':
        this.sendTo(`a:${effect.agentId}`, effect.message)
        return
      case 'send_agents':
        this.sendTo('role:host', effect.message)
        return
      case 'broadcast':
        this.sendAll(effect.message)
        return
      case 'provision_call':
        // Floating on purpose. Awaiting it would hold the single-threaded object
        // for the length of two RealtimeKit round trips, freezing the queue for
        // everyone else. The runtime keeps the object alive while the promise is
        // pending, and the outcome arrives back as another command.
        void this.provision(effect.callId, effect.agentId, effect.agentName, effect.visitorId, effect.firstName)
        return
      case 'release_call':
        void this.release(effect.callId, effect.meetingId)
        return
      case 'db':
        void safeDb(effect.op.t, () => applyDbOp(this.env, effect.op))
        return
      case 'analytics':
        void recordEvent(this.env, {
          name: effect.name,
          siteId: effect.siteId,
          visitorId: effect.visitorId,
          props: { ...(effect.props ?? {}), agentId: effect.agentId }
        })
        return
    }
  }

  /**
   * A Durable Object has ONE alarm slot, so every deadline in the product —
   * invitation countdowns, agent grace, visitor grace, in-call reconnect —
   * collapses into the single earliest timestamp. `tick` in the reducer is
   * written to apply all of them, because by the time the alarm fires several
   * may have passed.
   */
  private async rearmAlarm(state: RoomState): Promise<void> {
    const deadline = nextDeadline(state, this.settings())
    const current = await this.ctx.storage.getAlarm()
    if (deadline === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    if (current === null || Math.abs(current - deadline) > 1000) await this.ctx.storage.setAlarm(deadline)
  }

  override async alarm(): Promise<void> {
    await this.dispatch({ t: 'TICK', now: Date.now(), ids: this.idPool() })
  }

  // ─── RealtimeKit ───────────────────────────────────────────────────────────

  private async provision(callId: string, agentId: string, agentName: string, visitorId: string, firstName: string): Promise<void> {
    try {
      const result = await provisionCall(this.env, {
        callId,
        hostName: agentName,
        visitorName: firstName,
        visitorId,
        hostId: agentId
      })
      const tokens: CallTokens = {
        meetingId: result.meetingId,
        hostToken: result.host.authToken,
        visitorToken: result.visitor.authToken,
        hostParticipantId: result.host.participantId,
        visitorParticipantId: result.visitor.participantId
      }
      // Stored, not broadcast. The tokens are handed out one request at a time to
      // a caller that already proved it holds the call secret.
      await this.ctx.storage.put(tokensKey(callId), tokens)
      // The call may have ended while RealtimeKit was still creating it — the
      // visitor declined, the invitation expired, the agent went offline.
      // Nothing will ever redeem these tokens, so revoke them now rather than
      // leave a meeting open with two live tokens for it. (No fetch happens
      // between this load and the dispatch, so the check cannot go stale.)
      const alive = Object.values((await this.load()).calls).some((c) => c.callId === callId)
      if (!alive) {
        console.warn('[room] call ended during provisioning; releasing', callId)
        await this.release(callId, result.meetingId)
        return
      }
      await this.dispatch({ t: 'CALL_PROVISIONED', now: Date.now(), callId, meetingId: result.meetingId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[room] provisioning failed', message)
      await this.dispatch({ t: 'CALL_PROVISION_FAILED', now: Date.now(), callId, error: message, ids: this.idPool() })
    }
  }

  private async release(callId: string, meetingId: string | null): Promise<void> {
    const tokens = await this.ctx.storage.get<CallTokens>(tokensKey(callId))
    await this.ctx.storage.delete(tokensKey(callId))
    if (!tokens && !meetingId) return
    const creds = realtimeCredentials(this.env)
    if (!creds) return
    const room = tokens?.meetingId ?? meetingId
    if (!room) return
    // Deleting the participants revokes their tokens, which is what actually shuts
    // a stale tab out of a finished call.
    const participants = tokens ? [tokens.hostParticipantId, tokens.visitorParticipantId].filter(Boolean) : []
    await releaseMeeting(creds, room, participants)
  }

  // ─── RPC surface (called from the Worker) ──────────────────────────────────

  /**
   * Exchanges a call secret for that participant's media credentials.
   *
   * This is the only way into a call. The room id is not a capability — without
   * a token minted here nobody can join, which is what keeps a third party out
   * even if they learn the meeting id. The agent seat additionally requires the
   * caller to be the agent this call belongs to.
   */
  async redeemCall(input: { callId: string; secret: string; who: 'host' | 'visitor'; visitorId?: string; agentId?: string }): Promise<RedeemResult> {
    const state = await this.load()
    const call = Object.values(state.calls).find((c) => c.callId === input.callId)
    if (!call) return { ok: false, error: 'call_not_found' }
    if (!timingSafeEqual(input.secret, call.callSecret)) return { ok: false, error: 'bad_secret' }
    if (input.who === 'visitor' && input.visitorId !== call.visitorId) return { ok: false, error: 'not_your_call' }
    if (input.who === 'host' && input.agentId !== call.agentId) return { ok: false, error: 'not_your_call' }

    const tokens = await this.ctx.storage.get<CallTokens>(tokensKey(input.callId))
    if (!tokens) return { ok: false, error: 'not_ready' }

    return {
      ok: true,
      meetingId: tokens.meetingId,
      authToken: input.who === 'host' ? tokens.hostToken : tokens.visitorToken,
      displayName: input.who === 'host' ? call.agentName : call.firstName
    }
  }

  /** Reported by the call page once RealtimeKit says the room was actually joined. */
  async mediaPresence(input: { callId: string; who: 'host' | 'visitor'; joined: boolean }): Promise<void> {
    await this.dispatch({ t: input.joined ? 'MEDIA_JOINED' : 'MEDIA_LEFT', now: Date.now(), callId: input.callId, who: input.who })
  }

  /** Presence for the widget bootstrap, so a page can render before its socket opens. */
  async snapshot(): Promise<{ presence: ReturnType<typeof presenceView>; hostProfile: HostProfileView }> {
    const state = await this.load()
    return { presence: presenceView(state, this.settings()), hostProfile: await this.hostProfile() }
  }

  /** Drops the cached host profile after the dashboard edits it, and re-sends each socket a snapshot. */
  async invalidateProfile(): Promise<void> {
    this.profileCache = null
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(ws)
      if (attachment) await this.sendHello(ws, attachment)
    }
  }

  // ─── WebSocket lifecycle ───────────────────────────────────────────────────

  /**
   * The only fetch this object serves: the WebSocket upgrade. Origin, site and
   * agent validation already happened in the Worker — by the time a request
   * arrives here it has been authorised, and the query parameters are trusted.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/connect') return new Response('not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })

    const role = (url.searchParams.get('role') ?? 'widget') as ClientRole
    const visitorId = url.searchParams.get('visitorId') ?? undefined
    const siteId = url.searchParams.get('siteId') ?? undefined
    const agentId = url.searchParams.get('agentId') ?? undefined
    const agentName = url.searchParams.get('agentName') ?? undefined
    const agentRole = (url.searchParams.get('agentRole') ?? undefined) as AgentRole | undefined
    if (role === 'host' && (!agentId || !agentName)) return new Response('agent identity required', { status: 400 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    // Tags are how a specific person is reached after hibernation: a Map keyed
    // by id would not survive eviction, `getWebSockets('a:ari')` does.
    const tags = [`role:${role === 'host' ? 'host' : role === 'waiting_visitor' ? 'visitor' : 'widget'}`]
    if (visitorId) tags.push(`v:${visitorId}`)
    if (siteId) tags.push(`s:${siteId}`)
    if (agentId) tags.push(`a:${agentId}`)

    this.ctx.acceptWebSocket(server, tags)

    const attachment: SocketAttachment = { role, visitorId, siteId, agentId, agentName, agentRole, connId: randomId('c'), connectedAt: Date.now() }
    server.serializeAttachment(attachment)

    if (role === 'host' && agentId && agentName) {
      // The absolute count (this socket is already accepted, so it is included)
      // rather than "+1": a stored counter cannot drift after a crash this way.
      const connections = this.ctx.getWebSockets(`a:${agentId}`).length
      await this.dispatch({ t: 'HOST_CONNECT', now: Date.now(), agentId, name: agentName, connections })
    } else if (visitorId) {
      // A reconnect inside the grace window lands here and restores the entry
      // rather than creating one, so a refreshed tab keeps its place in line.
      await this.dispatch({ t: 'VISITOR_CONNECT', now: Date.now(), visitorId })
    }

    await this.sendHello(server, attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  private async sendHello(ws: WebSocket, attachment: SocketAttachment): Promise<void> {
    const state = await this.load()
    const now = Date.now()
    const settings = this.settings()
    const profile = await this.hostProfile()

    const payload = {
      role: attachment.role,
      presence: presenceView(state, settings),
      hostProfile: profile,
      settings: { inviteTimeoutSeconds: settings.inviteTimeoutSeconds, assignment: state.assignment },
      ...(attachment.role === 'host' && attachment.agentId
        ? {
            me: { agentId: attachment.agentId, name: attachment.agentName ?? attachment.agentId, role: attachment.agentRole ?? 'agent' },
            queue: state.queue.map(queueEntryView),
            agents: agentViews(state),
            calls: activeCallViews(state)
          }
        : {}),
      ...(attachment.visitorId ? { self: selfView(state, attachment.visitorId, settings, now) } : {})
    }

    // An agent needs their own call's secret to reopen it after a dashboard
    // refresh mid-conversation. Only theirs; widgets never receive any.
    const own = attachment.agentId ? state.calls[attachment.agentId] : undefined
    if (own) {
      this.send(ws, serverMsg('CALL_CONNECTING', {
        callId: own.callId, callSecret: own.callSecret, visitorId: own.visitorId, firstName: own.firstName, agentId: own.agentId, agentName: own.agentName
      }, now))
    }
    this.send(ws, serverMsg('HELLO', payload, now))
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachmentOf(ws)
    if (!attachment) {
      this.send(ws, serverMsg('ERROR', { code: 'internal', message: 'socket has no identity' }))
      return
    }
    const parsed = parseClientMessage(raw)
    if (!parsed.ok) {
      this.send(ws, serverMsg('ERROR', { code: 'invalid_payload', message: parsed.reason }))
      return
    }

    const outcome = await commandFromMessage({
      message: parsed.message,
      attachment,
      now: Date.now(),
      idPool: (size) => this.idPool(size),
      ownCall: () => this.ownCall(attachment)
    })
    if (outcome.kind === 'command') await this.dispatch(outcome.command)
    else if (outcome.kind === 'error') this.send(ws, serverMsg('ERROR', { code: outcome.code, message: outcome.message, commandId: outcome.commandId }))
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string, _clean: boolean): Promise<void> {
    await this.handleDisconnect(ws)
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleDisconnect(ws)
  }

  /**
   * A closed socket does not immediately mean a departed person. The reducer only
   * records *when* the last socket went; the alarm decides, a grace period later,
   * whether they actually left. Mobile Safari suspending a backgrounded tab is
   * indistinguishable from a close, and evicting on sight would drop people who
   * simply switched apps for ten seconds.
   */
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const attachment = this.attachmentOf(ws)
    if (!attachment) return
    const now = Date.now()

    if (attachment.role === 'host' && attachment.agentId) {
      // The closing socket may still be listed, so exclude it explicitly rather
      // than trusting the count.
      const remaining = this.ctx.getWebSockets(`a:${attachment.agentId}`).filter((other) => other !== ws).length
      await this.dispatch({ t: 'HOST_DISCONNECT', now, agentId: attachment.agentId, remaining })
      return
    }
    const visitorId = attachment.visitorId
    if (!visitorId) return
    const remaining = this.ctx.getWebSockets(`v:${visitorId}`).filter((other) => other !== ws).length
    await this.dispatch({ t: 'VISITOR_DISCONNECT', now, visitorId, remaining })
  }

  // ─── Introspection for /host and /_health ──────────────────────────────────

  async debugState(): Promise<{
    status: string
    queueLength: number
    agents: Array<{ id: string; intent: string; connections: number }>
    sockets: { host: number; widget: number; visitor: number }
    visitorsConnected: number
    alarmAt: number | null
  }> {
    const state = await this.load()
    return {
      status: deriveStatus(state),
      queueLength: state.queue.length,
      agents: Object.values(state.agents).map((a) => ({ id: a.id, intent: a.intent, connections: a.connections })),
      sockets: {
        host: this.ctx.getWebSockets('role:host').length,
        widget: this.ctx.getWebSockets('role:widget').length,
        visitor: this.ctx.getWebSockets('role:visitor').length
      },
      visitorsConnected: this.connectedVisitors().size,
      alarmAt: await this.ctx.storage.getAlarm()
    }
  }
}

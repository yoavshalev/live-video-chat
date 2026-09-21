/**
 * State machine tests.
 *
 * These matter more than any pixel. The queue is the product: if it loses
 * someone's place, invites two people at once, or leaves an agent stuck as busy
 * after a dropped call, nothing else about the widget is worth anything.
 *
 * Every test drives the same pure reducer the Durable Object runs, with time
 * injected on each command. Nothing is mocked because there is nothing to mock —
 * which is exactly why the machine was factored out of the DO.
 *
 * Two agents, "ari" and "ben", unless a test says otherwise. Round-robin order
 * with everything equal is alphabetical, so ari goes first.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type RoomSettings } from '../src/config'
import {
  agentStatus,
  deriveStatus,
  initialState,
  isCurrentState,
  nextDeadline,
  positionView,
  reduce,
  selfView,
  type Command,
  type Effect,
  type Ids,
  type RoomState
} from '../src/shared/machine'
import type { ServerMessage } from '../src/shared/protocol'

const SETTINGS: RoomSettings = { ...DEFAULT_SETTINGS }

/** Deterministic ids, so an assertion can name the call it expects. */
let counter = 0
function ids(n = 3): Ids[] {
  return Array.from({ length: n }, () => {
    counter += 1
    return { queueEntryId: `qs${counter}`, callId: `call${counter}`, callSecret: `secret${counter}0000000000000000` }
  })
}

class Room {
  state: RoomState
  effects: Effect[] = []

  constructor(assignment: 'auto' | 'manual' = 'auto') {
    this.state = initialState('org', assignment)
  }

  run(command: Command): this {
    const result = reduce(this.state, command, SETTINGS)
    this.state = result.state
    this.effects = result.effects
    return this
  }

  messagesTo(visitorId: string): ServerMessage[] {
    return this.effects
      .filter((e): e is Extract<Effect, { k: 'send_visitor' }> => e.k === 'send_visitor' && e.visitorId === visitorId)
      .map((e) => e.message)
  }

  messagesToAgent(agentId: string): ServerMessage[] {
    return this.effects
      .filter((e): e is Extract<Effect, { k: 'send_agent' }> => e.k === 'send_agent' && e.agentId === agentId)
      .map((e) => e.message)
  }

  types(): string[] {
    return this.effects.map((e) =>
      e.k === 'send_visitor' || e.k === 'send_agent' || e.k === 'send_agents' || e.k === 'broadcast' ? `${e.k}:${e.message.type}` : e.k
    )
  }

  get queueIds(): string[] {
    return this.state.queue.map((e) => e.visitorId)
  }

  invitedBy(agentId: string): string | undefined {
    return this.state.invites[agentId]?.visitorId
  }
}

function connect(room: Room, agentId: string, now = 1_000): Room {
  return room.run({ t: 'HOST_CONNECT', now, agentId, name: agentId.toUpperCase() })
}

function goLive(room: Room, agentId: string, now = 1_000): Room {
  connect(room, agentId, now)
  return room.run({ t: 'HOST_GO_LIVE', now, commandId: `live-${agentId}-${now}`, agentId, ids: ids() })
}

function join(room: Room, visitorId: string, now: number, siteId = 'example', email: string | null = null): Room {
  return room
    .run({ t: 'VISITOR_CONNECT', now, visitorId })
    .run({
      t: 'QUEUE_JOIN',
      now,
      commandId: `join-${visitorId}-${now}`,
      visitorId,
      queueEntryId: `qs-${visitorId}`,
      firstName: visitorId.toUpperCase(),
      email,
      company: null,
      question: 'Can I use this for my newsletter?',
      siteId,
      pageUrl: 'https://example.com/pricing',
      pageTitle: 'Sponsors',
      referrer: null,
      ids: ids()
    })
}

/** Drives an invited visitor all the way into a live call. */
function reachInCall(room: Room, agentId: string, visitorId: string, at: number): string {
  room.run({ t: 'VISITOR_ACCEPT_INVITE', now: at, commandId: `take-${visitorId}-${at}`, visitorId })
  const callId = room.state.calls[agentId]!.callId
  room.run({ t: 'CALL_PROVISIONED', now: at, callId, meetingId: `meet-${callId}` })
  room.run({ t: 'MEDIA_JOINED', now: at + 100, callId, who: 'host' })
  room.run({ t: 'MEDIA_JOINED', now: at + 200, callId, who: 'visitor' })
  return callId
}

// ─────────────────────────────────────────────────────────────────────────────

describe('presence', () => {
  it('1. starts offline and goes live when an agent says so', () => {
    const room = new Room()
    expect(deriveStatus(room.state)).toBe('offline')
    goLive(room, 'ari')
    expect(deriveStatus(room.state)).toBe('available')
    expect(agentStatus(room.state, 'ari')).toBe('available')
  })

  it('the organization is available while ANY agent is, busy only when all are', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    room.run({ t: 'ACCEPT_NEXT', now: 3_000, commandId: 'a1', agentId: 'ari', ids: ids() })
    expect(agentStatus(room.state, 'ari')).toBe('busy')
    expect(deriveStatus(room.state)).toBe('available') // ben is still free

    join(room, 'bob', 4_000)
    room.run({ t: 'ACCEPT_NEXT', now: 5_000, commandId: 'b1', agentId: 'ben', ids: ids() })
    expect(deriveStatus(room.state)).toBe('busy')
  })

  it('15. the last agent going offline propagates, clears the queue and tells everyone', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    room.run({ t: 'HOST_GO_OFFLINE', now: 4_000, commandId: 'off-1', agentId: 'ari', ids: ids() })

    expect(deriveStatus(room.state)).toBe('offline')
    expect(room.state.queue).toHaveLength(0)
    for (const visitorId of ['alice', 'bob']) {
      const updates = room.messagesTo(visitorId).filter((m) => m.type === 'SELF_UPDATE')
      expect(updates).toHaveLength(1)
      expect((updates[0] as Extract<ServerMessage, { type: 'SELF_UPDATE' }>).payload.status).toBe('expired')
    }
  })

  it('one agent going offline leaves the queue for the others', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)

    room.run({ t: 'HOST_GO_OFFLINE', now: 4_000, commandId: 'off-1', agentId: 'ari', ids: ids() })

    expect(deriveStatus(room.state)).toBe('available')
    expect(room.queueIds).toEqual(['alice'])
  })

  it('a paused agent stays live to widgets but takes nobody; all paused refuses joins', () => {
    const room = new Room()
    goLive(room, 'ari')
    room.run({ t: 'HOST_PAUSE', now: 2_000, commandId: 'pause-1', agentId: 'ari' })
    expect(deriveStatus(room.state)).toBe('paused')

    join(room, 'alice', 3_000)
    expect(room.state.queue).toHaveLength(0)
    expect(room.messagesTo('alice')[0]?.type).toBe('ERROR')

    room.run({ t: 'HOST_RESUME', now: 4_000, commandId: 'resume-1', agentId: 'ari', ids: ids() })
    join(room, 'alice', 5_000)
    expect(room.queueIds).toEqual(['alice'])
  })
})

describe('the queue', () => {
  it('2, 3, 4. visitors join and hold strict FIFO positions', () => {
    const room = new Room('manual')
    goLive(room, 'ari')

    join(room, 'alice', 2_000)
    expect(positionView(room.state, 'alice', SETTINGS, 2_000)?.position).toBe(1)
    join(room, 'bob', 3_000)
    join(room, 'carol', 4_000)

    expect(room.queueIds).toEqual(['alice', 'bob', 'carol'])
    expect(positionView(room.state, 'bob', SETTINGS, 4_000)).toMatchObject({ position: 2, peopleAhead: 1 })
    expect(positionView(room.state, 'carol', SETTINGS, 4_000)).toMatchObject({ position: 3, peopleAhead: 2 })
  })

  it('5, 6. when the first visitor leaves, the second becomes next', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    room.run({ t: 'QUEUE_LEAVE', now: 4_000, commandId: 'leave-1', visitorId: 'alice', ids: ids() })

    expect(room.queueIds).toEqual(['bob'])
    expect(positionView(room.state, 'bob', SETTINGS, 4_000)).toMatchObject({ position: 1, peopleAhead: 0 })
  })

  it('14. a duplicate join from the same visitor is rejected, not duplicated', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'alice', 2_500)

    expect(room.state.queue).toHaveLength(1)
    const replies = room.messagesTo('alice')
    expect(replies[0]?.type).toBe('ERROR')
    expect(replies[1]?.type).toBe('QUEUE_POSITION_UPDATE')
  })

  it('refuses to join when nobody is live', () => {
    const room = new Room()
    join(room, 'alice', 2_000)
    expect(room.state.queue).toHaveLength(0)
  })

  it('caps the queue rather than letting it grow without bound', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    for (let i = 0; i < SETTINGS.maxQueueLength; i++) join(room, `v${i}`, 2_000 + i)
    expect(room.state.queue).toHaveLength(SETTINGS.maxQueueLength)
    join(room, 'one-too-many', 9_000)
    expect(room.state.queue).toHaveLength(SETTINGS.maxQueueLength)
    expect(room.messagesTo('one-too-many')[0]?.type).toBe('ERROR')
  })
})

describe('round-robin assignment', () => {
  it('hands arrivals to free agents, least recently assigned first', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    goLive(room, 'ben')

    join(room, 'alice', 2_000)
    expect(room.invitedBy('ari')).toBe('alice') // alphabetical on a clean slate
    expect(room.invitedBy('ben')).toBeUndefined()

    join(room, 'bob', 3_000)
    expect(room.invitedBy('ben')).toBe('bob')

    // Both busy: the third person waits, assigned to nobody.
    join(room, 'carol', 4_000)
    expect(room.state.queue.find((e) => e.visitorId === 'carol')).toMatchObject({ status: 'waiting', assignedTo: null })
  })

  it('rotates: after ben was assigned most recently, ari goes next', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000) // → ari
    join(room, 'bob', 3_000) // → ben
    reachInCall(room, 'ari', 'alice', 4_000)
    reachInCall(room, 'ben', 'bob', 4_500)

    // Both calls end; ben's ends first. Carol joins. Ari was assigned at 2_000,
    // ben at 3_000 — ari has waited longer, so ari gets carol even though ben
    // freed up first.
    room.run({ t: 'CALL_END', now: 10_000, commandId: 'e-ben', callId: room.state.calls.ben!.callId, reason: 'host_ended', ids: ids() })
    room.run({ t: 'CALL_END', now: 11_000, commandId: 'e-ari', callId: room.state.calls.ari!.callId, reason: 'host_ended', ids: ids() })
    join(room, 'carol', 12_000)
    expect(room.invitedBy('ari')).toBe('carol')
  })

  it('an agent who comes online with people waiting is handed one immediately', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000) // → ari
    join(room, 'bob', 3_000) // waits

    goLive(room, 'ben', 4_000)
    expect(room.invitedBy('ben')).toBe('bob')
  })

  it('skips agents who are busy, paused, or whose dashboard is gone', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    goLive(room, 'ben')
    room.run({ t: 'HOST_PAUSE', now: 1_500, commandId: 'p', agentId: 'ari' })
    room.run({ t: 'HOST_DISCONNECT', now: 1_600, agentId: 'ben', remaining: 0 })

    join(room, 'alice', 2_000)
    expect(room.invitedBy('ari')).toBeUndefined()
    expect(room.invitedBy('ben')).toBeUndefined()
    expect(room.state.queue[0]?.status).toBe('waiting')

    // Ben's tab comes back: the waiting visitor is handed to him.
    room.run({ t: 'HOST_CONNECT', now: 2_500, agentId: 'ben', name: 'BEN' })
    room.run({ t: 'TICK', now: 2_600, ids: ids() })
    expect(room.invitedBy('ben')).toBe('alice')
  })

  it('manual mode assigns nobody until an agent presses Accept', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    expect(room.invitedBy('ari')).toBeUndefined()

    room.run({ t: 'ACCEPT_NEXT', now: 3_000, commandId: 'acc', agentId: 'ari', ids: ids() })
    expect(room.invitedBy('ari')).toBe('alice')
  })

  it('switching to auto assigns everyone waiting, as far as agents allow', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    join(room, 'carol', 4_000)

    room.run({ t: 'HOST_SET_ASSIGNMENT', now: 5_000, commandId: 'auto', mode: 'auto', ids: ids(5) })
    expect(room.invitedBy('ari')).toBe('alice')
    expect(room.invitedBy('ben')).toBe('bob')
    expect(room.state.queue.find((e) => e.visitorId === 'carol')?.status).toBe('waiting')
  })

  it('stops assigning when the id pool runs dry and resumes on the next event', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    room.run({ t: 'HOST_SET_ASSIGNMENT', now: 5_000, commandId: 'auto', mode: 'auto', ids: ids(1) })
    expect(room.invitedBy('ari')).toBe('alice')
    expect(room.invitedBy('ben')).toBeUndefined()

    room.run({ t: 'TICK', now: 5_100, ids: ids() })
    expect(room.invitedBy('ben')).toBe('bob')
  })
})

describe('invitations', () => {
  it('7, 8. an agent accepts and exactly that visitor is invited, by that agent', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    room.run({ t: 'ACCEPT_NEXT', now: 4_000, commandId: 'accept-1', agentId: 'ben', ids: ids() })

    expect(room.invitedBy('ben')).toBe('alice')
    expect(agentStatus(room.state, 'ben')).toBe('busy')
    expect(agentStatus(room.state, 'ari')).toBe('available')
    const invitation = room.messagesTo('alice').find((m) => m.type === 'CALL_INVITATION')
    expect((invitation as Extract<ServerMessage, { type: 'CALL_INVITATION' }>).payload.agentName).toBe('BEN')
    expect(room.messagesTo('bob')).toHaveLength(0)
    expect(room.types()).toContain('provision_call')
  })

  it('two agents cannot invite the same visitor', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    room.run({ t: 'ACCEPT_VISITOR', now: 3_000, commandId: 'a', agentId: 'ari', visitorId: 'alice', ids: ids() })
    room.run({ t: 'ACCEPT_VISITOR', now: 3_001, commandId: 'b', agentId: 'ben', visitorId: 'alice', ids: ids() })

    expect(room.invitedBy('ari')).toBe('alice')
    expect(room.invitedBy('ben')).toBeUndefined()
    expect(room.messagesToAgent('ben')[0]?.type).toBe('ERROR')
  })

  it('the invited visitor keeps their place until the call starts', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    expect(positionView(room.state, 'bob', SETTINGS, 4_000)?.position).toBe(2)
  })

  it('9, 10. an expired invitation advances to the next visitor', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    const expiry = 2_000 + SETTINGS.inviteTimeoutSeconds * 1000
    expect(nextDeadline(room.state, SETTINGS)).toBe(expiry)
    room.run({ t: 'TICK', now: expiry + 1, ids: ids() })

    expect(room.messagesTo('alice').map((m) => m.type)).toContain('CALL_INVITATION_EXPIRED')
    expect(room.queueIds).toEqual(['bob'])
    expect(room.invitedBy('ari')).toBe('bob')
  })

  it('an invitation that expires in the same instant it is accepted does not connect', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    const expiry = room.state.invites.ari!.expiresAt
    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: expiry + 5, commandId: 'take-1', visitorId: 'alice' })
    expect(room.state.calls.ari).toBeUndefined()
    expect(room.messagesTo('alice').map((m) => m.type)).toContain('CALL_INVITATION_EXPIRED')
  })

  it('a visitor who leaves while being invited frees the agent immediately', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    room.run({ t: 'QUEUE_LEAVE', now: 4_500, commandId: 'leave-1', visitorId: 'alice', ids: ids() })
    expect(room.state.invites.ari).toBeUndefined()
    expect(room.state.calls.ari).toBeUndefined()
    expect(agentStatus(room.state, 'ari')).toBe('available')
  })

  it('two dashboard tabs of the same agent accepting at once produce one invitation', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    room.run({ t: 'ACCEPT_NEXT', now: 4_000, commandId: 'tab-a', agentId: 'ari', ids: ids() })
    room.run({ t: 'ACCEPT_NEXT', now: 4_001, commandId: 'tab-b', agentId: 'ari', ids: ids() })
    expect(room.invitedBy('ari')).toBe('alice')
    expect(room.messagesToAgent('ari')[0]?.type).toBe('ERROR')
  })

  it('replaying the same commandId is a no-op', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    room.run({ t: 'ACCEPT_NEXT', now: 4_000, commandId: 'accept-once', agentId: 'ari', ids: ids() })
    const callId = room.state.calls.ari?.callId
    room.run({ t: 'ACCEPT_NEXT', now: 4_100, commandId: 'accept-once', agentId: 'ari', ids: ids() })
    expect(room.state.calls.ari?.callId).toBe(callId)
    expect(room.effects).toHaveLength(0)
  })

  it('an agent going offline after the visitor accepted, but before the call connected, returns them to the front', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben') // idle, so the queue is not released when ari leaves
    join(room, 'alice', 2_000)
    join(room, 'bob', 2_500)
    room.run({ t: 'ACCEPT_VISITOR', now: 2_800, commandId: 'acc', agentId: 'ari', visitorId: 'alice', ids: ids() })
    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 3_000, commandId: 'take', visitorId: 'alice' })
    expect(room.queueIds).toEqual(['bob'])

    room.run({ t: 'HOST_GO_OFFLINE', now: 4_000, commandId: 'off', agentId: 'ari', ids: ids() })

    // Nothing happened yet for alice, so she is back at the FRONT, not the back,
    // and told so — her widget is on the call screen and needs to come back.
    expect(room.queueIds).toEqual(['alice', 'bob'])
    const self = room.messagesTo('alice').find((m) => m.type === 'SELF_UPDATE') as Extract<ServerMessage, { type: 'SELF_UPDATE' }>
    expect(self.payload.status).toBe('waiting')
    expect(self.payload.position?.position).toBe(1)
    expect(room.types()).toContain('release_call')
    expect(room.types()).not.toContain('broadcast:CALL_ENDED')
  })

  it('an agent going offline mid-invitation returns the visitor to the line for someone else', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000) // → ari
    goLive(room, 'ben', 2_500) // nobody waiting for ben

    room.run({ t: 'HOST_GO_OFFLINE', now: 3_000, commandId: 'off', agentId: 'ari', ids: ids() })

    // Alice was not at fault: she is back in line — and round-robin hands her
    // to ben in the same step.
    expect(room.queueIds).toEqual(['alice'])
    expect(room.invitedBy('ben')).toBe('alice')
    expect(room.state.invites.ari).toBeUndefined()
  })
})

describe('calls', () => {
  it('11. a call starts once both sides are actually in the room', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)

    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 5_000, commandId: 'take-1', visitorId: 'alice' })
    expect(room.state.calls.ari?.status).toBe('provisioning')
    expect(room.queueIds).toEqual([])

    const callId = room.state.calls.ari!.callId
    room.run({ t: 'CALL_PROVISIONED', now: 5_100, callId, meetingId: 'meet-1' })
    expect(room.state.calls.ari?.status).toBe('connecting')
    room.run({ t: 'MEDIA_JOINED', now: 5_200, callId, who: 'host' })
    expect(room.state.calls.ari?.status).toBe('connecting')
    room.run({ t: 'MEDIA_JOINED', now: 5_300, callId, who: 'visitor' })
    expect(room.state.calls.ari?.status).toBe('in_call')
    expect(room.types()).toContain('broadcast:CALL_STARTED')
  })

  it('12, 13. ending a call records it and hands the agent the next visitor', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    const callId = reachInCall(room, 'ari', 'alice', 5_000)

    const endAt = 5_200 + 420_000
    room.run({ t: 'CALL_END', now: endAt, commandId: 'end-1', callId, reason: 'host_ended', ids: ids() })

    expect(room.state.calls.ari?.callId).not.toBe(callId)
    expect(room.invitedBy('ari')).toBe('bob')
    expect(room.state.recentDurations).toEqual([420])
    expect(room.effects.some((e) => e.k === 'db' && e.op.t === 'call_end' && e.op.durationSeconds === 420)).toBe(true)
  })

  it('two agents hold two calls at once, independently', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    const c1 = reachInCall(room, 'ari', 'alice', 4_000)
    const c2 = reachInCall(room, 'ben', 'bob', 4_500)
    expect(Object.keys(room.state.calls).sort()).toEqual(['ari', 'ben'])

    room.run({ t: 'CALL_END', now: 9_000, commandId: 'e1', callId: c1, reason: 'host_ended', ids: ids() })
    expect(room.state.calls.ari).toBeUndefined()
    expect(room.state.calls.ben?.callId).toBe(c2)
    expect(deriveStatus(room.state)).toBe('available')
  })

  it('a call that never connected does not pollute the wait estimate', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 5_000, commandId: 'take-1', visitorId: 'alice' })
    room.run({ t: 'TICK', now: 5_000 + SETTINGS.callConnectTimeoutSeconds * 1000 + 1, ids: ids() })
    expect(room.state.calls.ari).toBeUndefined()
    expect(room.state.recentDurations).toEqual([])
  })

  it('ends the call when one side stays gone past the reconnect window', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    const callId = reachInCall(room, 'ari', 'alice', 5_000)

    room.run({ t: 'MEDIA_LEFT', now: 10_000, callId, who: 'visitor' })
    room.run({ t: 'TICK', now: 10_000 + SETTINGS.activeCallReconnectSeconds * 1000 - 1_000, ids: ids() })
    expect(room.state.calls.ari).toBeDefined()

    room.run({ t: 'MEDIA_JOINED', now: 30_000, callId, who: 'visitor' })
    expect(room.state.calls.ari?.visitorLeftAt).toBeNull()

    room.run({ t: 'MEDIA_LEFT', now: 40_000, callId, who: 'visitor' })
    room.run({ t: 'TICK', now: 40_000 + SETTINGS.activeCallReconnectSeconds * 1000 + 1, ids: ids() })
    expect(room.state.calls.ari).toBeUndefined()
  })

  it('restores the visitor to the line if provisioning fails, holds, then tries the next agent', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000) // → ari
    goLive(room, 'ben', 2_500)

    room.run({ t: 'CALL_PROVISION_FAILED', now: 3_000, callId: room.state.calls.ari!.callId, error: 'RealtimeKit 502', ids: ids() })

    // Alice is back in line and NOBODY is invited yet: a provisioning failure is
    // a system failure, and re-inviting at once is a hot loop against a broken
    // dependency — it once took a Worker down.
    expect(room.state.calls.ari).toBeUndefined()
    expect(room.queueIds).toEqual(['alice'])
    expect(room.state.queue[0]?.status).toBe('waiting')
    expect(Object.keys(room.state.invites)).toEqual([])
    const retryAt = 3_000 + SETTINGS.provisionRetrySeconds * 1000
    expect(nextDeadline(room.state, SETTINGS)).toBe(retryAt)

    room.run({ t: 'TICK', now: retryAt - 1, ids: ids() })
    expect(Object.keys(room.state.invites)).toEqual([])

    // Once the hold passes, the rotation continues — ben, since ari was assigned last.
    room.run({ t: 'TICK', now: retryAt, ids: ids() })
    expect(room.invitedBy('ben')).toBe('alice')
    expect(room.types()).toContain('provision_call')
  })

  it('ignores media reports before the meeting exists', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    room.run({ t: 'ACCEPT_NEXT', now: 3_000, commandId: 'a1', agentId: 'ari', ids: ids() })
    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 3_500, commandId: 'v1', visitorId: 'alice' })
    const callId = room.state.calls.ari!.callId
    expect(room.state.calls.ari?.meetingId).toBeNull()

    // Nobody can be in a room that does not exist yet; a report that says so
    // must not mark the call live.
    room.run({ t: 'MEDIA_JOINED', now: 3_600, callId, who: 'host' })
    room.run({ t: 'MEDIA_JOINED', now: 3_700, callId, who: 'visitor' })
    expect(room.state.calls.ari?.status).not.toBe('in_call')
    expect(room.state.calls.ari?.hostPresent).toBe(false)
    expect(room.types()).not.toContain('broadcast')
  })

  it('a visitor put back in line keeps their details and their original join time', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000, 'example', 'alice@example.com') // → ari
    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 2_500, commandId: 'v1', visitorId: 'alice' })
    expect(room.queueIds).toEqual([])

    room.run({ t: 'CALL_PROVISION_FAILED', now: 3_000, callId: room.state.calls.ari!.callId, error: 'RealtimeKit 502', ids: ids() })
    const restored = room.state.queue[0]
    expect(restored?.visitorId).toBe('alice')
    expect(restored?.joinedAt).toBe(2_000)
    expect(restored?.email).toBe('alice@example.com')
    expect(restored?.pageUrl).toBe('https://example.com/pricing')
  })

  it('an agent can still accept by hand during a provisioning hold', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000) // → ari
    room.run({ t: 'CALL_PROVISION_FAILED', now: 3_000, callId: room.state.calls.ari!.callId, error: 'RealtimeKit 502', ids: ids() })
    expect(Object.keys(room.state.invites)).toEqual([])

    room.run({ t: 'ACCEPT_NEXT', now: 4_000, commandId: 'manual-retry', agentId: 'ari', ids: ids() })
    expect(room.invitedBy('ari')).toBe('alice')
    expect(room.types()).toContain('provision_call')
  })

  it('a reconnect reports the true socket count rather than adding one', () => {
    const room = new Room('auto')
    connect(room, 'ari')
    connect(room, 'ari', 1_500)
    expect(room.state.agents.ari?.connections).toBe(2)
    // A crash left the counter stale; the next connect knows the real number.
    room.run({ t: 'HOST_CONNECT', now: 2_000, agentId: 'ari', name: 'ARI', connections: 1 })
    expect(room.state.agents.ari?.connections).toBe(1)
  })
})

describe('disconnects', () => {
  it('16. a brief reconnect preserves queue membership and position', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)

    room.run({ t: 'VISITOR_DISCONNECT', now: 4_000, visitorId: 'alice', remaining: 0 })
    expect(room.state.queue[0]?.connected).toBe(false)
    room.run({ t: 'TICK', now: 4_000 + SETTINGS.visitorDisconnectGraceSeconds * 1000 - 1_000, ids: ids() })
    expect(room.queueIds).toEqual(['alice', 'bob'])

    room.run({ t: 'VISITOR_CONNECT', now: 34_000, visitorId: 'alice' })
    expect(room.state.queue[0]?.connected).toBe(true)
    expect(positionView(room.state, 'alice', SETTINGS, 40_000)?.position).toBe(1)
  })

  it('evicts a visitor who never comes back, and moves everyone else up', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    room.run({ t: 'VISITOR_DISCONNECT', now: 4_000, visitorId: 'alice', remaining: 0 })
    room.run({ t: 'TICK', now: 4_000 + SETTINGS.visitorDisconnectGraceSeconds * 1000 + 1, ids: ids() })
    expect(room.queueIds).toEqual(['bob'])
  })

  it('a second tab closing does not start the disconnect clock', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    room.run({ t: 'VISITOR_DISCONNECT', now: 4_000, visitorId: 'alice', remaining: 1 })
    expect(room.state.queue[0]?.connected).toBe(true)
  })

  it('an agent closing the dashboard goes offline only after the grace window', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)

    room.run({ t: 'HOST_DISCONNECT', now: 4_000, agentId: 'ari', remaining: 0 })
    expect(deriveStatus(room.state)).toBe('available')
    room.run({ t: 'TICK', now: 4_000 + SETTINGS.hostDisconnectGraceSeconds * 1000 - 1_000, ids: ids() })
    expect(deriveStatus(room.state)).toBe('available')

    room.run({ t: 'HOST_CONNECT', now: 24_000, agentId: 'ari', name: 'ARI' })
    room.run({ t: 'TICK', now: 4_000 + SETTINGS.hostDisconnectGraceSeconds * 1000 + 1, ids: ids() })
    expect(deriveStatus(room.state)).toBe('available')
    expect(room.queueIds).toEqual(['alice'])
  })

  it('an agent who never comes back takes their call down, and the queue only if they were the last', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    reachInCall(room, 'ari', 'alice', 4_000)

    room.run({ t: 'HOST_DISCONNECT', now: 5_000, agentId: 'ari', remaining: 0 })
    room.run({ t: 'TICK', now: 5_000 + SETTINGS.hostDisconnectGraceSeconds * 1000 + 1, ids: ids() })

    expect(deriveStatus(room.state)).toBe('offline')
    expect(room.state.calls.ari).toBeUndefined()
    expect(room.types()).toContain('broadcast:CALL_ENDED')
  })
})

describe('wait estimates', () => {
  it('says nothing until there is enough history to be honest', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    expect(positionView(room.state, 'bob', SETTINGS, 3_000)?.estimatedWaitSeconds).toBeNull()

    room.state = { ...room.state, recentDurations: [300, 360, 420] }
    expect(positionView(room.state, 'bob', SETTINGS, 3_000)?.estimatedWaitSeconds).toBe(360)
  })

  it('divides the wait by the number of live agents', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    goLive(room, 'ben')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    join(room, 'carol', 4_000)
    room.state = { ...room.state, recentDurations: [600, 600, 600] }
    // Two people ahead, two agents working: about one call, not two.
    expect(positionView(room.state, 'carol', SETTINGS, 4_000)?.estimatedWaitSeconds).toBe(600)
  })

  it('includes the remainder of the soonest-ending call when nobody is free', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    reachInCall(room, 'ari', 'alice', 5_000)
    room.state = { ...room.state, recentDurations: [600, 600, 600] }
    expect(positionView(room.state, 'bob', SETTINGS, 5_000 + 120_000)?.estimatedWaitSeconds).toBe(480)
  })
})

describe('the visitor self view', () => {
  it('restores a refreshed tab to where it actually is', () => {
    const room = new Room('auto')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)

    const invited = selfView(room.state, 'alice', SETTINGS, 2_000)
    expect(invited.status).toBe('invited')
    expect(invited.invite?.callSecret).toBeTruthy()
    expect(invited.invite?.agentName).toBe('ARI')

    room.run({ t: 'VISITOR_ACCEPT_INVITE', now: 4_500, commandId: 'take-1', visitorId: 'alice' })
    expect(selfView(room.state, 'alice', SETTINGS, 4_500).status).toBe('connecting')
  })

  it('reports nothing for someone who was never in line', () => {
    const room = new Room()
    goLive(room, 'ari')
    expect(selfView(room.state, 'stranger', SETTINGS, 1_000)).toMatchObject({ status: 'browsing', position: null, invite: null })
  })
})

describe('alarm scheduling', () => {
  it('collapses every pending deadline into the earliest one', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    expect(nextDeadline(room.state, SETTINGS)).toBeNull()

    room.run({ t: 'VISITOR_DISCONNECT', now: 4_000, visitorId: 'bob', remaining: 0 })
    expect(nextDeadline(room.state, SETTINGS)).toBe(4_000 + SETTINGS.visitorDisconnectGraceSeconds * 1000)

    room.run({ t: 'ACCEPT_NEXT', now: 5_000, commandId: 'accept-1', agentId: 'ari', ids: ids() })
    expect(nextDeadline(room.state, SETTINGS)).toBe(5_000 + SETTINGS.inviteTimeoutSeconds * 1000)
  })

  it('a single tick applies several deadlines that passed together', () => {
    const room = new Room('manual')
    goLive(room, 'ari')
    join(room, 'alice', 2_000)
    join(room, 'bob', 3_000)
    join(room, 'carol', 3_500)
    room.run({ t: 'VISITOR_DISCONNECT', now: 4_000, visitorId: 'bob', remaining: 0 })
    room.run({ t: 'VISITOR_DISCONNECT', now: 4_100, visitorId: 'carol', remaining: 0 })
    room.run({ t: 'TICK', now: 4_100 + SETTINGS.visitorDisconnectGraceSeconds * 1000 + 5_000, ids: ids() })
    expect(room.queueIds).toEqual(['alice'])
  })
})

describe('persisted state', () => {
  it('recognises its own shape and rejects the pre-multi-agent one', () => {
    expect(isCurrentState(initialState('org'))).toBe(true)
    expect(isCurrentState({ hostId: 'someone', hostIntent: 'live', queue: [] })).toBe(false)
    expect(isCurrentState(null)).toBe(false)
  })
})

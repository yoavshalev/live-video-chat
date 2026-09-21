/**
 * The Durable Object's message → command mapping, which is where a socket's
 * identity is enforced. Pure apart from two callbacks, so it runs here without
 * a Durable Object.
 */

import { describe, expect, it } from 'vitest'
import { commandFromMessage, type CommandContext } from '../src/durable/commands'
import { clientMsg, type ClientMessage, type SocketAttachment } from '../src/shared/protocol'
import type { CallRecord } from '../src/shared/machine'

const ids = () => [{ queueEntryId: 'q1', callId: 'c1', callSecret: 's1' }]

const agent: SocketAttachment = { role: 'host', agentId: 'ari', agentName: 'Ari', agentRole: 'agent', connId: 'x', connectedAt: 0 }
const visitor: SocketAttachment = { role: 'waiting_visitor', visitorId: 'v1', siteId: 'example', connId: 'y', connectedAt: 0 }

const ownCall = { callId: 'call_9', agentId: 'ari', visitorId: 'v1' } as CallRecord

function run(message: ClientMessage, attachment: SocketAttachment, call: CallRecord | undefined = undefined) {
  const ctx: CommandContext = { message, attachment, now: 1_000, idPool: ids, ownCall: async () => call }
  return commandFromMessage(ctx)
}

describe('socket messages become commands', () => {
  it('lets an agent go live, and refuses a visitor who tries', async () => {
    expect(await run(clientMsg('HOST_GO_LIVE', { commandId: 'a' }), agent)).toMatchObject({ kind: 'command', command: { t: 'HOST_GO_LIVE', agentId: 'ari' } })
    expect(await run(clientMsg('HOST_GO_LIVE', { commandId: 'a' }), visitor)).toMatchObject({ kind: 'error', code: 'unauthorized' })
  })

  it("ends only the caller's own call, found from the socket, not the payload", async () => {
    expect(await run(clientMsg('CALL_END', { commandId: 'e', reason: 'host_ended' }), agent, ownCall)).toMatchObject({
      kind: 'command',
      command: { t: 'CALL_END', callId: 'call_9', reason: 'host_ended' }
    })
    expect(await run(clientMsg('CALL_END', { commandId: 'e', reason: 'visitor_left' }), visitor, ownCall)).toMatchObject({
      command: { reason: 'visitor_left' }
    })
    expect(await run(clientMsg('CALL_END', { commandId: 'e', reason: 'host_ended' }), agent)).toMatchObject({ kind: 'error', code: 'no_active_call' })
  })

  it('ignores a media report for a call that is not the caller’s', async () => {
    expect(await run(clientMsg('CALL_MEDIA_JOINED', { commandId: 'm', callId: 'someone_elses' }), agent, ownCall)).toEqual({ kind: 'ignore' })
    expect(await run(clientMsg('CALL_MEDIA_JOINED', { commandId: 'm', callId: 'call_9' }), visitor, ownCall)).toMatchObject({
      command: { t: 'MEDIA_JOINED', callId: 'call_9', who: 'visitor' }
    })
  })

  it("takes the site from the socket, never from the join payload", async () => {
    const outcome = await run(
      clientMsg('QUEUE_JOIN', { commandId: 'j', firstName: 'Alex', pageUrl: 'https://example.com/pricing' }),
      visitor
    )
    expect(outcome).toMatchObject({ command: { t: 'QUEUE_JOIN', visitorId: 'v1', siteId: 'example', firstName: 'Alex' } })
    expect(await run(clientMsg('QUEUE_JOIN', { commandId: 'j', firstName: 'Alex', pageUrl: 'https://x' }), agent)).toMatchObject({ kind: 'error' })
  })

  it('drops heartbeats without a command', async () => {
    expect(await run(clientMsg('HEARTBEAT', {}), visitor)).toEqual({ kind: 'ignore' })
  })
})

/**
 * Change detection for the Durable Object.
 *
 * Rather than making the reducer remember to emit "and tell the widgets", the
 * shell diffs a signature of the state before and after each command. A
 * transition can never forget to broadcast, and a no-op command can never
 * produce a spurious one. Three signatures, one per audience.
 */

import type { RoomSettings } from '../config'
import { presenceView, type RoomState } from '../shared/machine'

/** What every widget sees: org status, queue length, live since, the estimate. */
export function presenceSignature(state: RoomState, settings: RoomSettings): string {
  const view = presenceView(state, settings)
  return `${view.status}|${view.queueLength}|${view.liveSince ?? 0}|${view.agentsLive}|${view.averageCallSeconds ?? -1}`
}

/** What every dashboard sees: the queue, each agent, each call, the mode. */
export function dashboardSignature(state: RoomState): string {
  const queue = state.queue.map((e) => `${e.visitorId}:${e.status}:${e.assignedTo ?? ''}:${e.connected ? 1 : 0}`).join(',')
  const agents = Object.values(state.agents)
    .map((a) => `${a.id}:${a.intent}:${a.connections > 0 ? 1 : 0}:${state.invites[a.id]?.visitorId ?? ''}`)
    .join(',')
  const calls = Object.values(state.calls)
    .map((c) => `${c.callId}:${c.status}:${c.hostPresent ? 1 : 0}${c.visitorPresent ? 1 : 0}`)
    .join(',')
  return `${queue}#${agents}#${calls}#${state.assignment}`
}

/** Only when the ORDER changes does everyone's position change. */
export function orderSignature(state: RoomState): string {
  return state.queue.map((e) => e.visitorId).join(',')
}

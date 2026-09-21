/**
 * Access to the single LiveHostRoom instance.
 *
 * One host means one Durable Object id, derived from a name rather than a random
 * id so that any Worker isolate anywhere in the world resolves the same object
 * without storing a pointer. That is what makes presence global: a widget in
 * Sydney and the dashboard in Tel Aviv are talking to the same instance.
 */

import type { Env } from '../types'
import type { LiveHostRoom } from '../durable/LiveHostRoom'

export function room(env: Env): DurableObjectStub<LiveHostRoom> {
  return env.LIVE_HOST_ROOM.get(env.LIVE_HOST_ROOM.idFromName(env.ORG_ID))
}

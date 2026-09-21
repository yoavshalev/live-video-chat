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
 *
 * Layout: ./types.ts (state, commands, effects), ./views.ts (what clients are
 * shown, and the next alarm), ./transitions.ts (the moves), ./reduce.ts (the
 * switch that composes them).
 */

export type {
  AgentState,
  AnalyticsName,
  CallRecord,
  Command,
  DbOp,
  Effect,
  Ids,
  Invite,
  QueueEntry,
  Result,
  RoomState
} from './types'
export { initialState, isCurrentState } from './types'
export {
  activeCallView,
  activeCallViews,
  agentStatus,
  agentView,
  agentViews,
  availableAgents,
  averageCallSeconds,
  callById,
  callFor,
  deriveStatus,
  nextDeadline,
  positionView,
  presenceView,
  queueEntryView,
  selfView
} from './views'
export { reduce } from './reduce'

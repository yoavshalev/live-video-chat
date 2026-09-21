/**
 * D1 access, one module per concern. Every statement in the app lives under
 * this directory so the schema has exactly one set of callers.
 *
 *   profile.ts   the organization row: intro clip and wording
 *   agents.ts    who may sign in
 *   history.ts   queue sessions and calls as they happen, the inbox, recent activity
 *   messages.ts  the offline form
 *   metrics.ts   today's numbers for the dashboard
 *
 * The history writes are called from the Durable Object *after* it has already
 * broadcast the corresponding state change, wrapped in `safeDb` so a D1 outage
 * costs a gap in reporting and never a stuck queue. The agent functions are the
 * other kind: they are the source of truth for who may sign in, and their
 * callers want the error.
 */

export { safeDb } from './safe'
export { getHostProfile, updateHostProfile } from './profile'
export {
  countAgents,
  countEnabledAdmins,
  createAgent,
  createFirstAdmin,
  getAgentByEmail,
  getAgentById,
  listAgents,
  slugify,
  summarize,
  touchAgentLogin,
  updateAgent,
  type AgentRecord,
  type AgentResult,
  type AgentSummary
} from './agents'
export { applyDbOp, listInbox, recentSessions, startOfTodayUtc, type InboxItem, type RecentSession } from './history'
export { insertOfflineMessage, listOfflineMessages, type OfflineMessageInput, type OfflineMessageRow } from './messages'
export { getTodayMetrics, type TodayMetrics } from './metrics'

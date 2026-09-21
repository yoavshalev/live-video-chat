/**
 * What the dashboard knows, in one place. `live` is owned by the socket — the
 * server says what is true and the client only draws it. `data` is the
 * slower-moving stuff the page arrived with and the admin tabs edit.
 */

import type { ActiveCallView, AgentView, AssignmentMode, HostStatus, PresenceView, QueueEntryView } from '../../src/shared/protocol'
import { boot, type AgentSummary, type Site } from './boot'

export const live = {
  presence: null as PresenceView | null,
  queue: [] as QueueEntryView[],
  agents: [] as AgentView[],
  calls: [] as ActiveCallView[],
  assignment: 'auto' as AssignmentMode,
  /** Our own call's bearer secret, sent only to us; needed to open the call iframe. */
  callSecret: null as string | null,
  connected: false
}

export const data = {
  sites: (boot.sites ?? []) as Site[],
  team: (boot.agents ?? []) as AgentSummary[]
}

/** My own call, if any — the one the main area shows. */
export function myCall(): ActiveCallView | null {
  return live.calls.find((c) => c.agentId === boot.me.agentId) ?? null
}

/** My own status, as the server sees it. Drives every control in the header. */
export function myStatus(): HostStatus {
  return live.agents.find((a) => a.id === boot.me.agentId)?.status ?? 'offline'
}

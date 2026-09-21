/**
 * When the dashboard should keep nagging the host.
 *
 * Pure, so it can be tested without a DOM. The rule is deliberately narrow:
 * ring while somebody is waiting AND the host is free to take them. Ringing
 * during a call would interrupt the conversation; ringing while paused would
 * nag about a choice the host just made; ringing while offline makes no sense.
 */

export type HostStatus = 'offline' | 'available' | 'busy' | 'paused'

export interface AlertState {
  queueLength: number
  hostStatus: HostStatus
  soundEnabled: boolean
}

/** How often the chime repeats while the conditions hold. */
export const NAG_INTERVAL_MS = 20_000

/** How fast the tab title alternates while nagging. */
export const TITLE_FLASH_MS = 1_200

export function shouldNag(state: AlertState): boolean {
  return state.soundEnabled && state.queueLength > 0 && state.hostStatus === 'available'
}

/** The attention-grabbing tab title while somebody waits. */
export function nagTitle(queueLength: number): string {
  return `🔔 ${queueLength} waiting`
}

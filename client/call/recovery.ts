/**
 * When to re-acquire a microphone the platform has muted, and how often.
 *
 * iOS mutes a capture — `track.muted`, which a page cannot clear — when a
 * newer capture starts, when Safari leaves the foreground, or when another
 * app takes the microphone. The only way back is a fresh capture. This module
 * decides when that is worth doing on its own; it is pure so the policy can be
 * tested without a browser.
 */

export interface RecoveryState {
  /** When the current track was first seen muted; null while it is fine. */
  mutedSince: number | null
  /** When automatic re-acquisitions happened, oldest first. */
  automatic: number[]
}

export function initialRecovery(): RecoveryState {
  return { mutedSince: null, automatic: [] }
}

/** A track is briefly muted during a device change; act only once it has stayed muted this long. */
export const MUTE_SETTLE_MS = 1500
/** Automatic attempts per window. Beyond this the banner and its button take over. */
export const AUTO_RECOVERY_LIMIT = 3
export const AUTO_RECOVERY_WINDOW_MS = 60_000

/**
 * Re-acquire without asking? Only for a mute that has lasted, only while the
 * page is in the foreground (a backgrounded iOS page cannot capture anyway),
 * and only a few times a minute — a phone that mutes every fresh capture is
 * telling us something the person has to fix.
 */
export function shouldAutoRecover(state: RecoveryState, now: number, visible: boolean): boolean {
  if (state.mutedSince === null || !visible) return false
  if (now - state.mutedSince < MUTE_SETTLE_MS) return false
  return recentAutomatic(state, now).length < AUTO_RECOVERY_LIMIT
}

export function recordAutomatic(state: RecoveryState, now: number): RecoveryState {
  return { ...state, automatic: [...recentAutomatic(state, now), now] }
}

function recentAutomatic(state: RecoveryState, now: number): number[] {
  return state.automatic.filter((at) => now - at < AUTO_RECOVERY_WINDOW_MS)
}

import { describe, expect, it } from 'vitest'
import {
  AUTO_RECOVERY_LIMIT,
  AUTO_RECOVERY_WINDOW_MS,
  MUTE_SETTLE_MS,
  initialRecovery,
  recordAutomatic,
  shouldAutoRecover,
  type RecoveryState
} from '../client/call/recovery'

describe('microphone recovery policy', () => {
  it('does nothing while the track is fine', () => {
    expect(shouldAutoRecover(initialRecovery(), 10_000, true)).toBe(false)
  })

  it('waits for a mute to settle before acting on it', () => {
    const state = { ...initialRecovery(), mutedSince: 10_000 }
    expect(shouldAutoRecover(state, 10_000 + MUTE_SETTLE_MS - 1, true)).toBe(false)
    expect(shouldAutoRecover(state, 10_000 + MUTE_SETTLE_MS, true)).toBe(true)
  })

  it('never acts while the page is in the background', () => {
    const state = { ...initialRecovery(), mutedSince: 0 }
    expect(shouldAutoRecover(state, 60_000, false)).toBe(false)
  })

  it('stops after a few automatic attempts, then allows more once the window has passed', () => {
    let state: RecoveryState = { ...initialRecovery(), mutedSince: 0 }
    let now = MUTE_SETTLE_MS
    for (let i = 0; i < AUTO_RECOVERY_LIMIT; i++) {
      expect(shouldAutoRecover(state, now, true)).toBe(true)
      state = recordAutomatic(state, now)
      now += 2_000
    }
    expect(shouldAutoRecover(state, now, true)).toBe(false)
    expect(shouldAutoRecover(state, now + AUTO_RECOVERY_WINDOW_MS, true)).toBe(true)
  })

  it('forgets attempts older than the window', () => {
    const state = recordAutomatic({ ...initialRecovery(), automatic: [0, 1, 2] }, AUTO_RECOVERY_WINDOW_MS + 5)
    expect(state.automatic).toEqual([AUTO_RECOVERY_WINDOW_MS + 5])
  })
})

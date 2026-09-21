import { describe, expect, it } from 'vitest'
import { nagTitle, shouldNag } from '../client/host/alerts'

describe('shouldNag', () => {
  const base = { queueLength: 1, hostStatus: 'available' as const, soundEnabled: true }

  it('rings while somebody waits and the host is free', () => {
    expect(shouldNag(base)).toBe(true)
    expect(shouldNag({ ...base, queueLength: 3 })).toBe(true)
  })

  it('stops the moment the line is empty', () => {
    expect(shouldNag({ ...base, queueLength: 0 })).toBe(false)
  })

  it('never interrupts a call or an outstanding invitation', () => {
    // 'busy' covers both: a live call, and an invitation the visitor has not
    // yet accepted.
    expect(shouldNag({ ...base, hostStatus: 'busy' })).toBe(false)
  })

  it('respects a pause — the host just chose not to take people', () => {
    expect(shouldNag({ ...base, hostStatus: 'paused' })).toBe(false)
  })

  it('is silent while offline', () => {
    expect(shouldNag({ ...base, hostStatus: 'offline' })).toBe(false)
  })

  it('respects the mute toggle', () => {
    expect(shouldNag({ ...base, soundEnabled: false })).toBe(false)
  })
})

describe('nagTitle', () => {
  it('says how many are waiting', () => {
    expect(nagTitle(1)).toBe('🔔 1 waiting')
    expect(nagTitle(4)).toBe('🔔 4 waiting')
  })
})

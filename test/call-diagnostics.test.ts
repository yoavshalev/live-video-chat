import { describe, expect, it } from 'vitest'
import { sanitizeCallReport } from '../src/lib/call-diagnostics'

describe('call diagnostics sanitiser', () => {
  it('keeps only the known fields, so a report cannot pose as the verified ones', () => {
    const report = sanitizeCallReport({ callId: 'someone_elses', who: 'host', ua: 'Safari', extra: { deep: true } })
    expect(report).not.toBeNull()
    expect(Object.keys(report!)).not.toContain('callId')
    expect(Object.keys(report!)).not.toContain('who')
    expect(Object.keys(report!)).not.toContain('extra')
    expect(report!.ua).toBe('Safari')
  })

  it('bounds every string and drops values of the wrong type', () => {
    const report = sanitizeCallReport({
      ua: 'x'.repeat(1000),
      joined: 'yes',
      micLevel: 'loud',
      track: { id: 'abcdefghijklmnop', label: 'iPhone Microphone', muted: true, enabled: 1, readyState: 'live' }
    })!
    expect(report.ua).toHaveLength(200)
    expect(report.joined).toBeNull()
    expect(report.micLevel).toBeNull()
    expect(report.track).toEqual({ id: 'abcdefgh', label: 'iPhone Microphone', muted: true, enabled: null, readyState: 'live' })
  })

  it('caps the timeline and stringifies structured details', () => {
    const timeline = Array.from({ length: 100 }, (_, i) => ({ t: i, event: 'track:mute', detail: { id: 'ab' } }))
    const report = sanitizeCallReport({ timeline })!
    expect(report.timeline).toHaveLength(40)
    expect(report.timeline[0]).toEqual({ t: 0, event: 'track:mute', detail: '{"id":"ab"}' })
  })

  it('refuses anything that is not an object', () => {
    expect(sanitizeCallReport('report')).toBeNull()
    expect(sanitizeCallReport([1, 2])).toBeNull()
    expect(sanitizeCallReport(null)).toBeNull()
  })
})

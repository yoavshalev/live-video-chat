import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, passwordProblem } from '../src/lib/password'
// The CLI reimplements the hash in plain Node. If the two ever drift, agents
// created from the command line cannot log in — this test is what stops that.
import { hashPassword as cliHash, slugify } from '../scripts/agent.mjs'

describe('password hashing', () => {
  it('verifies what it hashed and rejects everything else', async () => {
    const stored = await hashPassword('correct horse battery staple', 1_000)
    expect(stored.startsWith('pbkdf2$1000$')).toBe(true)
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(stored, 'correct horse battery stapl')).toBe(false)
    expect(await verifyPassword(stored, '')).toBe(false)
  })

  it('salts, so the same password never hashes the same twice', async () => {
    const a = await hashPassword('same password here', 1_000)
    const b = await hashPassword('same password here', 1_000)
    expect(a).not.toBe(b)
  })

  it('never throws on a malformed stored value', async () => {
    for (const bad of [null, undefined, '', 'plaintext', 'pbkdf2$x$y$z', 'pbkdf2$1000$!!$!!', 'bcrypt$...']) {
      expect(await verifyPassword(bad, 'anything')).toBe(false)
    }
  })

  it('accepts a hash produced by the command-line tool', async () => {
    const stored = await cliHash('made by the cli tool', 1_000)
    expect(await verifyPassword(stored, 'made by the cli tool')).toBe(true)
    expect(await verifyPassword(stored, 'made by the cli tooL')).toBe(false)
  })

  it('has a length-only policy', () => {
    expect(passwordProblem('short')).not.toBeNull()
    expect(passwordProblem('twelve chars')).toBeNull()
  })

  it('slugifies names into ids', () => {
    expect(slugify('Ariel Cohen')).toBe('ariel-cohen')
    expect(slugify('  QinFlow!! ')).toBe('qinflow')
  })
})

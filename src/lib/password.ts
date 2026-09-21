/**
 * Password hashing for agent logins, on WebCrypto so the same code runs in the
 * Worker and in Node (scripts/agent.mjs reimplements exactly this, and
 * test/password.test.ts pins the two to each other).
 *
 * PBKDF2-SHA256 rather than bcrypt/scrypt/argon2 because it is what WebCrypto
 * offers natively — no dependency, no WASM, and the Worker never has to import
 * anything to verify a login.
 *
 * 100 000 iterations, because that is the most the Workers runtime allows:
 * deriveBits with a higher PBKDF2 count throws in production (local workerd
 * does not enforce it, so a higher number looks fine right up until the first
 * real login fails). It is the OWASP-recommended minimum for SHA-256 as of
 * 2023, and the login route is rate-limited to 8 attempts per IP per 15
 * minutes on top of it.
 *
 * Stored form: pbkdf2$<iterations>$<salt b64url>$<hash b64url>
 * The iteration count is in the string so it can be changed later without
 * invalidating existing hashes — as long as it stays within what the runtime
 * can verify.
 */

import { base64url, base64urlDecode, timingSafeEqual } from './security'

export const PBKDF2_ITERATIONS = 100_000
/** What the Workers runtime will actually run. A stored hash above this can never verify there. */
export const PBKDF2_MAX_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256

const encoder = new TextEncoder()

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, iterations)
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(hash)}`
}

/** Constant-time on the hash comparison; never throws on a malformed stored value. */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(iterations) || iterations < 1000) return false
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    // Refusing loudly rather than throwing quietly: this is a stored hash the
    // runtime cannot check, and the fix is `scripts/agent.mjs password`.
    console.error(`[password] stored hash uses ${iterations} iterations; the runtime allows ${PBKDF2_MAX_ITERATIONS}`)
    return false
  }
  try {
    const salt = base64urlDecode(parts[2] ?? '')
    const expected = parts[3] ?? ''
    const actual = base64url(await derive(password, salt, iterations))
    return timingSafeEqual(actual, expected)
  } catch (error) {
    console.error('[password] verification failed', error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Minimal policy. Length is what matters; composition rules mostly produce worse passwords. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.'
  if (password.length > 200) return 'That is too long.'
  return null
}

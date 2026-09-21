/** Id generation, constant-time comparison, and the cookie signing used by password auth. */

const encoder = new TextEncoder()

/**
 * Ids are URL-safe and prefixed so that a stray id in a log says what it is.
 * `crypto.randomUUID` is a CSPRNG in Workers, which matters for `callSecret`:
 * that value is the only thing standing between a stranger and a private call.
 */
export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

/** 256 bits of entropy for values that act as bearer tokens. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64url(bytes)
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Length-independent-ish equality. Comparing secrets with `===` leaks their
 * prefix through timing; this compares every byte regardless of mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ])
}

/**
 * `<payload>.<signature>` where payload is base64url JSON. Not a JWT on purpose:
 * this cookie is read by exactly one service and a bespoke two-field format has
 * no algorithm-confusion surface to get wrong.
 */
export async function signSession(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return `${body}.${base64url(new Uint8Array(signature))}`
}

export async function verifySession<T = Record<string, unknown>>(
  token: string,
  secret: string
): Promise<T | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  const key = await hmacKey(secret)
  let valid = false
  try {
    valid = await crypto.subtle.verify('HMAC', key, base64urlDecode(signature), encoder.encode(body))
  } catch {
    return null
  }
  if (!valid) return null

  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as T
  } catch {
    return null
  }
}

/** Stable, non-reversible bucket key for per-IP rate limiting. We never store the IP itself. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${ip}`))
  return base64url(new Uint8Array(digest)).slice(0, 22)
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '0.0.0.0'
}

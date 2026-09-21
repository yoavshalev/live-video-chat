/**
 * Cloudflare Access mode: Access sits in front of the hostname and injects a
 * JWT; this verifies it and maps the verified email to an agent row.
 *
 * The JWT is verified here rather than trusted on sight. The header is only
 * meaningful if Access is genuinely in front of every route to this Worker;
 * verifying the signature, audience and expiry means a misrouted request or a
 * direct hit on an unprotected hostname cannot forge a session by setting a
 * header. An email Access lets through that has no agent row yet is
 * provisioned as a plain agent — Access already decided they belong here.
 */

import type { Env } from '../types'
import type { AgentRole } from '../shared/protocol'
import { base64urlDecode } from './security'
import { countAgents, createAgent, getAgentByEmail, type AgentRecord } from './db'

interface AccessJwk {
  kid: string
  kty: string
  alg?: string
  use?: string
  n: string
  e: string
}

/**
 * Access rotates signing keys, so the key set is fetched and cached per isolate.
 * 10 minutes is short enough to follow a rotation and long enough that the
 * dashboard's own polling does not fetch certs on every request.
 */
const JWKS_TTL_MS = 10 * 60 * 1000
let jwksCache: { keys: AccessJwk[]; expires: number } | null = null

async function fetchAccessKeys(teamDomain: string): Promise<AccessJwk[]> {
  const now = Date.now()
  if (jwksCache && jwksCache.expires > now) return jwksCache.keys
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 600, cacheEverything: true } })
  if (!response.ok) throw new Error(`Access certs fetch failed: ${response.status}`)
  const body = (await response.json()) as { keys?: AccessJwk[] }
  const keys = body.keys ?? []
  jwksCache = { keys, expires: now + JWKS_TTL_MS }
  return keys
}

interface AccessClaims {
  aud?: string | string[]
  email?: string
  exp?: number
  iss?: string
}

/**
 * Verifies an Access JWT: RS256 signature against the team's published keys,
 * audience equal to this application's AUD tag, issuer equal to the team domain,
 * and not expired.
 *
 * The audience check is the one that is easy to skip and expensive to skip: every
 * application behind the same Access team is signed by the same keys, so without
 * it a token minted for an unrelated internal app would open this dashboard.
 */
export async function verifyAccessJwt(env: Env, token: string): Promise<string | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN
  const expectedAud = env.CF_ACCESS_AUD
  if (!teamDomain || !expectedAud) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { kid?: string; alg?: string }
  let claims: AccessClaims
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerPart))) as { kid?: string; alg?: string }
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as AccessClaims
  } catch {
    return null
  }
  // Pinned to RS256. Accepting whatever `alg` claims is the classic JWT
  // vulnerability — `none` and HMAC-with-the-public-key both live there.
  if (header.alg !== 'RS256' || !header.kid) return null

  const keys = await fetchAccessKeys(teamDomain)
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return null

  let valid = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64urlDecode(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`))
  } catch {
    return null
  }
  if (!valid) return null

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!audiences.includes(expectedAud)) return null
  if (claims.iss && claims.iss !== `https://${teamDomain}`) return null
  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null
  if (!claims.email) return null
  return claims.email.toLowerCase()
}

/** Access said this email may be here. Find the agent, or make one. */
export async function agentForAccessEmail(env: Env, email: string): Promise<AgentRecord | null> {
  const allowed = (env.ALLOWED_HOST_EMAIL ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  // A second, local gate so an Access policy widened by accident does not
  // silently widen the dashboard. Empty means "trust the Access policy".
  if (allowed.length > 0 && !allowed.includes(email)) return null

  const existing = await getAgentByEmail(env, email)
  if (existing) return existing.enabled === 1 ? existing : null

  // The very first person through the door runs the place.
  const role: AgentRole = (await countAgents(env)) === 0 ? 'admin' : 'agent'
  const local = email.split('@')[0] ?? 'agent'
  const name = local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  const result = await createAgent(env, { name, email, passwordHash: null, role })
  return result.ok ? result.agent : null
}

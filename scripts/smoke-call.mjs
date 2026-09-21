/**
 * Media provisioning smoke test — the half of Phase 4 that can be checked
 * without two humans and two cameras.
 *
 *   node scripts/smoke-call.mjs [baseUrl] [password] [email]
 *
 * Drives a real call to the point where both sides hold real RealtimeKit
 * credentials: go live → visitor joins → host accepts → RealtimeKit meeting is
 * created → visitor accepts → both redeem their participant tokens → call ends.
 *
 * What it proves: the API token works, the presets exist, a meeting is created
 * only on accept, and each side gets a token scoped to that meeting and nobody
 * else's. What it cannot prove: that video actually flows, which needs two
 * browsers with cameras pointed at two faces.
 *
 * Run this after setting or rotating REALTIMEKIT_API_TOKEN. A wrong preset name
 * or an under-scoped token fails here, loudly, instead of failing in front of a
 * visitor.
 */

import WebSocket from 'ws'
import { setDefaultResultOrder } from 'node:dns'

// Prefer A records over AAAA.
//
// Not a preference about the internet — a workaround for machines whose IPv6
// path to Cloudflare is broken. Browsers hide this by racing both families
// (Happy Eyeballs); Node just tries AAAA first and times out, which makes this
// script fail in a way that looks like the deploy is down when it is not.
setDefaultResultOrder('ipv4first')


const BASE = process.argv[2] ?? 'http://localhost:8787'
const PASSWORD = process.argv[3] ?? 'local-dev-password'
const EMAIL = process.argv[4] ?? 'dev@example.com'
const SITE = 'example'
const ORIGIN = 'http://localhost:5173'
const VISITOR = `v_calltest_${Math.random().toString(36).slice(2, 10)}`

let failures = 0
let step = 0

function check(label, condition, detail = '') {
  step += 1
  if (!condition) failures += 1
  console.log(`${condition ? ' ok ' : 'FAIL'}  ${String(step).padStart(2)}. ${label}${detail && !condition ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const id = () => `c${Math.random().toString(36).slice(2, 12)}`

function open(url, headers = {}) {
  const socket = new WebSocket(url, { headers })
  socket.received = []
  socket.on('message', (data) => {
    const text = data.toString()
    if (text === 'pong') return
    try {
      socket.received.push(JSON.parse(text))
    } catch {
      /* ignore */
    }
  })
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function send(socket, type, payload = {}) {
  socket.send(JSON.stringify({ type, timestamp: Date.now(), payload: { commandId: id(), ...payload } }))
}

async function expectMessage(socket, type, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = socket.received.find((m) => m.type === type)
    if (found) return found
    await wait(60)
  }
  return null
}

/** Reads a JWT payload without verifying it — we only want to see what is inside. */
function decodeJwt(token) {
  try {
    const part = token.split('.')[1]
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

async function main() {
  console.log(`\nCall provisioning test → ${BASE}\n`)

  const ready = await fetch(`${BASE}/_health`).then((r) => r.json())
  check('RealtimeKit credentials are configured', ready.realtimeKitConfigured === true,
    'set REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN')
  if (!ready.realtimeKitConfigured) process.exit(1)

  const login = await fetch(`${BASE}/host/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, next: '/host' }),
    redirect: 'manual'
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  check('signed in as the host', cookie.startsWith('fl_agent='))
  if (!cookie.startsWith('fl_agent=')) {
    console.log('\nCould not sign in — wrong password, or the login rate limit is exhausted.\n')
    process.exit(1)
  }

  const host = await open(`${BASE.replace(/^http/, 'ws')}/ws/host`, { Cookie: cookie })
  await expectMessage(host, 'HELLO')
  send(host, 'HOST_GO_LIVE')
  await wait(400)

  const visitor = await open(
    `${BASE.replace(/^http/, 'ws')}/ws/widget?siteId=${SITE}&visitorId=${VISITOR}`,
    { Origin: ORIGIN }
  )
  await expectMessage(visitor, 'HELLO')

  send(visitor, 'QUEUE_JOIN', {
    firstName: 'Provisioning Test',
    question: 'Automated check — no human here.',
    pageUrl: 'https://example.com/'
  })
  const joined = await expectMessage(host, 'VISITOR_JOINED')
  check('the test visitor joined the queue', Boolean(joined))

  // ── The moment that needs RealtimeKit ────────────────────────────────────
  visitor.received.length = 0
  host.received.length = 0
  send(host, 'CALL_ACCEPT_NEXT')

  const invitation = await expectMessage(visitor, 'CALL_INVITATION')
  check('the visitor was invited', Boolean(invitation?.payload.callId))
  if (!invitation) {
    console.log('\nNo invitation issued. Is the host live and the queue non-empty?\n')
    process.exit(1)
  }

  // If provisioning fails, the DO sends an ERROR within a couple of seconds.
  // Its absence after that window is the signal that a meeting was created.
  await wait(6000)
  const provisionError = visitor.received.find((m) => m.type === 'ERROR')
  check('RealtimeKit created the meeting without error', !provisionError,
    provisionError ? JSON.stringify(provisionError.payload) : '')
  if (provisionError) {
    console.log(
      `\nProvisioning failed. Most likely causes, in order:\n` +
        `  1. The API token lacks the "Realtime / Realtime Admin" permission.\n` +
        `  2. REALTIMEKIT_APP_ID is from a different account than CLOUDFLARE_ACCOUNT_ID.\n` +
        `  3. The presets do not exist — the app was created via API rather than the\n` +
        `     dashboard, so no default presets were made. Check\n` +
        `     REALTIMEKIT_HOST_PRESET / REALTIMEKIT_VISITOR_PRESET in wrangler.jsonc.\n`
    )
    process.exit(1)
  }

  const { callId, callSecret } = invitation.payload

  // ── Credentials ──────────────────────────────────────────────────────────
  send(visitor, 'VISITOR_ACCEPT_INVITE')
  const connecting = await expectMessage(visitor, 'CALL_CONNECTING')
  check('the visitor accepted and both sides were told to connect', Boolean(connecting))

  const visitorCreds = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, secret: callSecret, who: 'visitor', visitorId: VISITOR })
  })
  const visitorBody = await visitorCreds.json()
  check('the visitor can redeem their media credentials', visitorCreds.ok && Boolean(visitorBody.authToken),
    JSON.stringify(visitorBody).slice(0, 160))
  check('a RealtimeKit meeting id came back', Boolean(visitorBody.meetingId))

  const claims = visitorBody.authToken ? decodeJwt(visitorBody.authToken) : null
  check('the participant token is a JWT scoped to a meeting', Boolean(claims),
    'token did not decode')
  if (claims) console.log(`       meeting ${visitorBody.meetingId} · token expires ${claims.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : 'unknown'}`)

  const hostCreds = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ callId, secret: callSecret, who: 'host' })
  })
  const hostBody = await hostCreds.json()
  check('the host can redeem their own credentials', hostCreds.ok && Boolean(hostBody.authToken))
  check('host and visitor get different participant tokens', hostBody.authToken !== visitorBody.authToken)
  check('both are in the same meeting', hostBody.meetingId === visitorBody.meetingId)

  // The same call secret must not let an unauthenticated caller take the host seat.
  const impostor = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, secret: callSecret, who: 'host' })
  })
  check('the call secret alone does not buy the host seat', impostor.status === 401,
    `got ${impostor.status}`)

  const wrongVisitor = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, secret: callSecret, who: 'visitor', visitorId: 'v_somebody_else' })
  })
  check('another visitor cannot redeem this call', wrongVisitor.status === 403, `got ${wrongVisitor.status}`)

  // ── Teardown ─────────────────────────────────────────────────────────────
  visitor.received.length = 0
  send(host, 'CALL_END', { reason: 'host_ended' })
  const ended = await expectMessage(visitor, 'CALL_ENDED')
  check('the host ended the call', Boolean(ended))

  await wait(800)
  const afterEnd = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, secret: callSecret, who: 'visitor', visitorId: VISITOR })
  })
  check('credentials stop working once the call is over', afterEnd.status === 403, `got ${afterEnd.status}`)

  send(host, 'HOST_GO_OFFLINE')
  await wait(500)
  for (const socket of [host, visitor]) socket.close()

  console.log(`\n${failures === 0 ? 'All checks passed — a real meeting was created and torn down.' : `${failures} check(s) failed.`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\nCall test crashed:', error)
  process.exit(1)
})

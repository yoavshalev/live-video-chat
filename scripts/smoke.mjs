/**
 * End-to-end smoke test: drives the real product across the real wire.
 *
 *   node scripts/smoke.mjs [baseUrl] [password] [email]
 *
 * The unit suite proves the state machine is correct in isolation. This proves
 * the parts around it are wired up: origin checks, the host session, two kinds of
 * WebSocket, the Durable Object's broadcast fan-out, and D1 writes. It is the
 * cheapest way to answer "did I break the seam between the Worker and the DO",
 * which no amount of reducer testing can tell you.
 *
 * It expects HOST_AUTH_MODE=password and a seeded database. It does NOT expect
 * RealtimeKit credentials — the accept step is asserted to fail *gracefully*,
 * which is itself the behaviour worth pinning down for a half-configured deploy.
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

let failures = 0
let step = 0

function check(label, condition, detail = '') {
  step += 1
  const mark = condition ? ' ok ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${String(step).padStart(2)}. ${label}${detail && !condition ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const id = () => `c${Math.random().toString(36).slice(2, 12)}`

/**
 * A socket that records everything it receives, so assertions can be made about
 * messages that arrived while the test was doing something else — which is most
 * of them, in a system whose whole job is pushing updates.
 */
function open(url, headers = {}) {
  const socket = new WebSocket(url, { headers })
  socket.received = []
  socket.on('message', (data) => {
    const text = data.toString()
    if (text === 'pong') return
    try {
      socket.received.push(JSON.parse(text))
    } catch {
      /* ignore non-JSON frames */
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

/** Waits for a message of a given type, or gives up. */
async function expectMessage(socket, type, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = socket.received.find((message) => message.type === type)
    if (found) return found
    await wait(50)
  }
  return null
}

async function main() {
  console.log(`\nFounderLive smoke test → ${BASE}\n`)

  // This suite is DISRUPTIVE: it toggles the host live and offline, joins and
  // leaves the queue, and accepts a call. Against production that means kicking
  // out whoever is genuinely connected — including the host mid-conversation.
  // Localhost is fair game; anything else has to be asked for explicitly.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE)
  if (!isLocal && !process.argv.includes('--disruptive')) {
    console.log(
      `Refusing to run against ${BASE}.

` +
        `This suite takes the host offline and manipulates the live queue, so running it
` +
        `while anyone is using the site disconnects them. Re-run with --disruptive if that
` +
        `is genuinely what you want:

` +
        `  node scripts/smoke.mjs ${BASE} <password> --disruptive

` +
        `For a safe production check, use the read-only probe:  curl ${BASE}/_health
`
    )
    process.exit(2)
  }

  // ── Liveness and readiness ───────────────────────────────────────────────
  const health = await fetch(`${BASE}/health`).then((r) => r.json())
  check('liveness probe responds', health.ok === true)

  const ready = await fetch(`${BASE}/_health`).then((r) => r.json())
  check('readiness probe reaches D1, KV, R2 and the Durable Object', ready.ok === true, JSON.stringify(ready.checks))

  // ── The embed boundary ───────────────────────────────────────────────────
  const noOrigin = await fetch(`${BASE}/embed/config?siteId=${SITE}`)
  check('config refuses a request with no Origin', noOrigin.status === 403, `got ${noOrigin.status}`)

  const wrongOrigin = await fetch(`${BASE}/embed/config?siteId=${SITE}`, {
    headers: { Origin: 'https://attacker.example' }
  })
  check('config refuses an origin that is not on the site allow-list', wrongOrigin.status === 403, `got ${wrongOrigin.status}`)

  const unknownSite = await fetch(`${BASE}/embed/config?siteId=not-a-site`, { headers: { Origin: ORIGIN } })
  check('config refuses an unknown siteId', unknownSite.status === 404, `got ${unknownSite.status}`)

  const configResponse = await fetch(`${BASE}/embed/config?siteId=${SITE}`, { headers: { Origin: ORIGIN } })
  const config = await configResponse.json()
  check('config serves an allowed origin', configResponse.ok && config.site?.id === SITE)
  check('config echoes the exact origin rather than a wildcard',
    configResponse.headers.get('access-control-allow-origin') === ORIGIN)

  // ── The widget asset ─────────────────────────────────────────────────────
  const widget = await fetch(`${BASE}/widget.js`)
  const widgetBody = await widget.text()
  check('widget.js is served and cacheable',
    widget.ok && (widget.headers.get('cache-control') ?? '').includes('max-age=3600'))
  check('widget.js contains no baked-in presence', !widgetBody.includes('"available"') || widgetBody.length > 1000)

  const cached = await fetch(`${BASE}/widget.js`, { headers: { 'If-None-Match': widget.headers.get('etag') } })
  check('widget.js answers a conditional request with 304', cached.status === 304, `got ${cached.status}`)

  // ── The video SDK ────────────────────────────────────────────────────────
  //
  // This route once 404'd for every request — Hono does not bind a `:param`
  // followed by a literal suffix in the same path segment — and the only symptom
  // was "Could not load the video SDK" at the moment of an actual call. Nothing
  // else in the suite touches it, so it is checked explicitly.
  const sdk = await fetch(`${BASE}/sdk/realtimekit-2.0.2-r2.js`)
  const sdkBody = sdk.ok ? await sdk.text() : ''
  check('the RealtimeKit SDK is served from our own origin',
    sdk.ok && (sdk.headers.get('content-type') ?? '').includes('javascript') && sdkBody.length > 10000,
    `status ${sdk.status}, ${sdkBody.length} bytes`)
  check('the SDK is cached immutably',
    (sdk.headers.get('cache-control') ?? '').includes('immutable'))

  const wrongSdk = await fetch(`${BASE}/sdk/realtimekit-0.0.0-r0.js`)
  check('an unknown SDK version says so rather than 404ing generically',
    wrongSdk.status === 404 && (await wrongSdk.text()).includes('unknown SDK version'))

  // ── Host authentication ──────────────────────────────────────────────────
  const anonymousDashboard = await fetch(`${BASE}/host`, { redirect: 'manual', headers: { Accept: 'text/html' } })
  check('the dashboard is not public', anonymousDashboard.status === 302, `got ${anonymousDashboard.status}`)

  const setup = await fetch(`${BASE}/setup`, { redirect: 'manual' })
  check('first-run setup is gone once an admin exists',
    setup.status === 302 && (setup.headers.get('location') ?? '').endsWith('/host/login'), `got ${setup.status}`)

  const badLogin = await fetch(`${BASE}/host/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: 'wrong', next: '/host' }),
    redirect: 'manual'
  })
  check('a wrong password does not create a session',
    !(badLogin.headers.get('set-cookie') ?? '').includes('fl_agent='))

  const login = await fetch(`${BASE}/host/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, next: '/host' }),
    redirect: 'manual'
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  check('the right password issues a session cookie', cookie.startsWith('fl_agent='))

  // Each run spends two of the eight login attempts allowed per IP per 15
  // minutes, so roughly four runs back to back exhaust the budget. Stopping with
  // an explanation beats a stack trace from the next WebSocket upgrade.
  if (!cookie.startsWith('fl_agent=')) {
    console.log(
      `\nCould not sign in. Either the password is wrong, or the host-login rate limit` +
        `\n(8 per IP per 15 minutes) is exhausted from repeated runs. Wait it out, or clear` +
        `\nthe local counters:\n\n` +
        `  node -e "const{DatabaseSync}=require('node:sqlite');` +
        `new DatabaseSync(require('node:fs').globSync('.wrangler/state/v3/kv/**/*.sqlite')` +
        `.find(f=>!f.endsWith('metadata.sqlite'))).prepare(\\"delete from _mf_entries where key like 'rl:hostLogin:%'\\").run()"\n`
    )
    process.exit(1)
  }

  const dashboard = await fetch(`${BASE}/host`, { headers: { Cookie: cookie } })
  const dashboardHtml = await dashboard.text()
  check('the dashboard renders for an authenticated host',
    dashboard.ok && dashboardHtml.includes('Up next'))

  const anonymousSocket = await open(`${BASE.replace(/^http/, 'ws')}/ws/host`).catch(() => null)
  check('the host socket rejects an unauthenticated upgrade', anonymousSocket === null)

  // ── Presence propagates ──────────────────────────────────────────────────
  const host = await open(`${BASE.replace(/^http/, 'ws')}/ws/host`, { Cookie: cookie })
  const hostHello = await expectMessage(host, 'HELLO')
  check('the host socket opens and receives a snapshot', hostHello?.payload.role === 'host')
  check('the snapshot lists the signed-in agent and the assignment mode',
    hostHello?.payload.agents?.some((a) => a.id === 'dev') && ['auto', 'manual'].includes(hostHello?.payload.settings?.assignment),
    JSON.stringify({ agents: hostHello?.payload.agents, settings: hostHello?.payload.settings }))
  // The mode persists in the Durable Object across runs, so pin it rather than
  // assume the default.
  send(host, 'HOST_SET_ASSIGNMENT', { mode: 'auto' })
  // A previous run that died mid-way leaves the agent live in the Durable
  // Object; start from offline so "going live" below is a real transition.
  send(host, 'HOST_GO_OFFLINE')
  await wait(300)

  const widgetSocket = await open(
    `${BASE.replace(/^http/, 'ws')}/ws/widget?siteId=${SITE}&visitorId=v_smoke_alice`,
    { Origin: ORIGIN }
  )
  await expectMessage(widgetSocket, 'HELLO')

  const rejected = await open(
    `${BASE.replace(/^http/, 'ws')}/ws/widget?siteId=${SITE}`,
    { Origin: 'https://attacker.example' }
  ).catch(() => null)
  check('the widget socket rejects a disallowed origin', rejected === null)

  widgetSocket.received.length = 0
  send(host, 'HOST_GO_LIVE')
  const presence = await expectMessage(widgetSocket, 'PRESENCE_UPDATE')
  check('going live reaches an already-connected widget', presence?.payload.status === 'available',
    JSON.stringify(presence?.payload))

  // A widget that connects afterwards sees the same thing, which is the part that
  // proves presence lives in the Durable Object and not in a socket's memory.
  const second = await open(
    `${BASE.replace(/^http/, 'ws')}/ws/widget?siteId=example-two&visitorId=v_smoke_bob`,
    { Origin: ORIGIN }
  )
  const secondHello = await expectMessage(second, 'HELLO')
  check('a widget on a different site sees the same live host',
    secondHello?.payload.presence.status === 'available')

  // ── Automatic assignment ─────────────────────────────────────────────────
  // In auto mode a joining visitor is invited with nobody clicking anything.
  widgetSocket.received.length = 0
  send(widgetSocket, 'QUEUE_JOIN', { firstName: 'Alice', pageUrl: 'https://example.com/pricing' })
  const autoInvite = await expectMessage(widgetSocket, 'CALL_INVITATION', 5000)
  check('automatic assignment invites a joining visitor with no click', Boolean(autoInvite?.payload.callId),
    JSON.stringify(widgetSocket.received.map((m) => m.type)))
  if (ready.realtimeKitConfigured) {
    send(widgetSocket, 'VISITOR_DECLINE_INVITE')
    await wait(500)
  } else {
    // Provisioning fails without RealtimeKit. The visitor must be told, kept in
    // line, and NOT re-invited in a loop: one invitation, then a hold.
    const failed = await expectMessage(widgetSocket, 'ERROR', 8000)
    await wait(1500)
    const invitations = widgetSocket.received.filter((m) => m.type === 'CALL_INVITATION').length
    check('a provisioning failure holds automatic assignment instead of re-inviting in a loop',
      failed?.payload.code === 'provision_failed' && invitations === 1,
      JSON.stringify({ code: failed?.payload.code, invitations }))
    send(widgetSocket, 'QUEUE_LEAVE')
    await wait(300)
  }

  // ── One central queue, across two sites ──────────────────────────────────
  // Manual from here on, so positions and accepts are the test's to drive.
  send(host, 'HOST_SET_ASSIGNMENT', { mode: 'manual' })
  await wait(300)
  host.received.length = 0
  widgetSocket.received.length = 0
  send(widgetSocket, 'QUEUE_JOIN', {
    firstName: 'Alice',
    email: 'alice@example.com',
    question: 'Can I use this for my newsletter?',
    pageUrl: 'https://example.com/pricing',
    pageTitle: 'Sponsors'
  })
  const joined = await expectMessage(host, 'VISITOR_JOINED')
  check('a visitor joining reaches the dashboard', joined?.payload.entry.firstName === 'Alice')
  check('the dashboard is told which site they came from', joined?.payload.entry.siteId === SITE)

  second.received.length = 0
  // Cleared so the QUEUE_UPDATE asserted below is the one caused by Bob, not the
  // still-buffered one from Alice's join a moment ago.
  host.received.length = 0
  send(second, 'QUEUE_JOIN', { firstName: 'Bob', pageUrl: 'https://example.org/pricing' })
  const bobPosition = await expectMessage(second, 'QUEUE_POSITION_UPDATE')
  check('a visitor from another site joins the SAME queue, behind the first',
    bobPosition?.payload.position === 2, JSON.stringify(bobPosition?.payload))

  const queueUpdate = await expectMessage(host, 'QUEUE_UPDATE')
  check('the dashboard sees both visitors in order',
    queueUpdate?.payload.queue.map((e) => e.firstName).join(',') === 'Alice,Bob',
    JSON.stringify(queueUpdate?.payload.queue.map((e) => e.firstName)))

  // Duplicate join from a second tab of the same visitor.
  send(widgetSocket, 'QUEUE_JOIN', { firstName: 'Alice again', pageUrl: 'https://example.com/pricing' })
  const duplicate = await expectMessage(widgetSocket, 'ERROR')
  check('a second tab does not become a second place in line',
    duplicate?.payload.code === 'already_queued', JSON.stringify(duplicate?.payload))

  // ── Leaving moves everyone up ────────────────────────────────────────────
  second.received.length = 0
  send(widgetSocket, 'QUEUE_LEAVE')
  const promoted = await expectMessage(second, 'QUEUE_POSITION_UPDATE')
  check('when the first visitor leaves, the second becomes next',
    promoted?.payload.position === 1, JSON.stringify(promoted?.payload))

  // ── Accepting, with RealtimeKit unconfigured ─────────────────────────────
  second.received.length = 0
  send(host, 'CALL_ACCEPT_NEXT')
  const invitation = await expectMessage(second, 'CALL_INVITATION')
  check('accepting invites exactly that visitor', Boolean(invitation?.payload.callId))
  check('the invitation carries a countdown', invitation?.payload.expiresAt > Date.now())
  check('the invitation carries a call secret nobody else was sent',
    typeof invitation?.payload.callSecret === 'string' && invitation.payload.callSecret.length >= 20)

  const alsoInvited = widgetSocket.received.find((m) => m.type === 'CALL_INVITATION')
  check('nobody else receives that invitation', alsoInvited === undefined)

  // What happens next depends on whether RealtimeKit is configured, and BOTH
  // outcomes are worth asserting. Unconfigured, provisioning must fail loudly to
  // the two people involved rather than hanging. Configured, a real meeting is
  // created and nobody hears an error at all. Asserting only one of them makes
  // this check fire on the wrong deploy.
  if (ready.realtimeKitConfigured) {
    await wait(6000)
    const unexpected = second.received.find((m) => m.type === 'ERROR')
    check('a configured RealtimeKit provisions the call without error', !unexpected,
      JSON.stringify(unexpected?.payload))
    // End it, so the suite does not leave a live meeting behind every run.
    send(host, 'CALL_END', { reason: 'host_ended' })
    await expectMessage(second, 'CALL_ENDED', 5000)
  } else {
    const provisionFailure = await expectMessage(second, 'ERROR', 8000)
    check('an unconfigured RealtimeKit fails gracefully rather than hanging',
      provisionFailure?.payload.code === 'provision_failed', JSON.stringify(provisionFailure?.payload))
  }

  const credentials = await fetch(`${BASE}/api/call/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId: 'call_not_real', secret: 'x'.repeat(32), who: 'visitor' })
  })
  check('call credentials are refused for a call that is not yours', credentials.status === 403,
    `got ${credentials.status}`)

  // ── The offline path ─────────────────────────────────────────────────────
  const message = await fetch(`${BASE}/api/offline-message?siteId=${SITE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      name: 'Carol',
      email: 'carol@example.com',
      message: 'Does this work with Shopify?',
      pageUrl: 'https://example.com/'
    })
  })
  // 200 or 429, and both are a pass. The production limit is 5 per hour per IP,
  // so running this suite six times in an hour legitimately hits it — and a
  // smoke test that fails because a rate limiter worked is testing itself, not
  // the product. What must never happen is any other status.
  check('an offline message is accepted from an allowed origin (or rate-limited)',
    message.ok || message.status === 429, `got ${message.status}`)

  const blockedMessage = await fetch(`${BASE}/api/offline-message?siteId=${SITE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ name: 'Spam', message: 'x' })
  })
  check('an offline message from a strange origin is refused', blockedMessage.status === 403)

  const messages = await fetch(`${BASE}/api/host/messages`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('the message lands in D1 and shows up for the host',
    messages.messages?.some((m) => m.name === 'Carol'))

  // ── Analytics ────────────────────────────────────────────────────────────
  const events = await fetch(`${BASE}/api/events?siteId=${SITE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify([
      { name: 'widget_opened', visitorId: 'v_smoke_alice', pageUrl: 'https://example.com/' },
      { name: 'not_a_real_event', visitorId: 'v_smoke_alice' }
    ])
  })
  check('analytics accepts a batch without blocking', events.status === 204)
  await wait(400)
  const metrics = await fetch(`${BASE}/api/host/metrics`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('the funnel event reaches the dashboard metrics', metrics.widgetOpens >= 1, JSON.stringify(metrics))
  check('queue joins are recorded', metrics.queueJoins >= 2, JSON.stringify(metrics))

  // ── Going offline ────────────────────────────────────────────────────────
  widgetSocket.received.length = 0
  send(host, 'HOST_GO_OFFLINE')
  const offline = await expectMessage(widgetSocket, 'PRESENCE_UPDATE')
  check('going offline reaches every widget immediately', offline?.payload.status === 'offline')

  const roomState = await fetch(`${BASE}/api/host/room`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('the room reports itself offline with an empty queue',
    roomState.status === 'offline' && roomState.queueLength === 0, JSON.stringify(roomState))

  for (const socket of [host, widgetSocket, second]) socket.close()

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error)
  process.exit(1)
})

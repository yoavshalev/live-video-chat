# Live Video Chat

A "talk to a real person right now" button for your websites.

One script tag on any number of sites. One dashboard for your team. One shared
queue. A visitor sees that someone is live, clicks, waits in line, and lands in a
private 1:1 video call — without installing anything, creating an account,
opening Zoom, or leaving the page they were on.

Runs entirely on your own Cloudflare account: Workers, Durable Objects, D1, KV,
R2 and [RealtimeKit](https://developers.cloudflare.com/realtime/realtimekit/)
for the WebRTC media. No servers, no third-party SaaS, no media passes through
your code.

```
widget on any site ──ws──┐
agent dashboards ───ws───┼──▶ LiveHostRoom (one Durable Object)
waiting visitors ───ws───┘        │
                                  ├─▶ D1            history, agents, sites, inbox
                                  ├─▶ KV            rate-limit windows
                                  ├─▶ R2            the intro clip
                                  └─▶ RealtimeKit   only when a call is accepted

/call (same-origin iframe) ──────▶ WebRTC, peer to Cloudflare's edge
```

## What you get

- **Live presence across every site.** An agent goes live on the dashboard and
  every widget switches on within a second. Nobody live → each site shows either
  an offline state with a leave-a-message form, or nothing at all (your choice,
  per site).
- **One queue, many agents, round-robin.** Visitors from all your sites wait in
  one FIFO line. Any number of agents can be live at once; the next person is
  handed to whoever has waited longest since their last call. Or switch to
  manual and let agents pick.
- **Invitations with a countdown.** The visitor gets 60 seconds to accept;
  expire or decline and the next person is up. Agents see who is waiting, from
  which site, how long, and what they wanted to talk about.
- **Private 1:1 calls in the page.** Camera, microphone, screen sharing from
  either side, mobile bottom sheet on phones. Exactly two participant tokens
  are ever minted per call; there is no way for a third person in.
- **Intro clip.** Record a 5–15s loop in the browser (or upload one). Shown
  while anyone is live, honestly labelled as a clip, never as a live feed.
- **Inbox.** Every join request and offline message, who took the call, and
  what happened to it.
- **Alerts.** A repeating chime, a flashing tab title and a browser
  notification while someone is waiting and you are free.
- **Wait estimates**, analytics, per-site name and offline behaviour, a domain
  allow-list with subdomain support, and a demo page for local development.

## Cost

Everything except the media is well inside Cloudflare's free or lowest paid
tier for a small team: a Durable Object that mostly hibernates, a few D1 rows
per visitor, one KV write per rate-limited request, one R2 object. RealtimeKit
bills per participant-minute of actual calls — check its current pricing — and
only calls that were accepted create a meeting; people waiting in line cost
nothing.

---

## Quick start (local)

Requirements: Node 20+, a free Cloudflare account, `npx wrangler login`.

```bash
git clone https://github.com/yoavshalev/live-video-chat
cd live-video-chat
npm install
cp .dev.vars.example .dev.vars        # local secrets; the defaults work as-is
npm run db:migrate && npm run db:seed # local D1: schema + two example sites + a dev admin
```

Three terminals:

```bash
npm run dev      # the Worker on http://localhost:8787
npm run demo     # a pretend customer site on http://localhost:8788
npm run smoke    # 45 end-to-end checks against both (optional)
```

Open <http://localhost:8787/host> and sign in as **dev@example.com /
local-dev-password**, go live, then open <http://localhost:8788> in another
browser (or a private window) and click the bubble.

Calls need RealtimeKit even locally: put `CLOUDFLARE_ACCOUNT_ID`,
`REALTIMEKIT_APP_ID` and `REALTIMEKIT_API_TOKEN` in `.dev.vars` (see
[RealtimeKit](#3-realtimekit) below). Everything up to the call — presence,
queue, invitations, inbox — works without them.

---

## Deploying to Cloudflare

### 1. Configuration file

`wrangler.jsonc` is a **template**: it has placeholder ids and an example
hostname. Copy it and keep your real values out of git:

```bash
cp wrangler.jsonc wrangler.prod.local.jsonc     # any wrangler.*.local.jsonc is gitignored
```

Every remote command below takes `--config wrangler.prod.local.jsonc`. (You can
also just edit `wrangler.jsonc` in place if you are not planning to contribute
back.)

### 2. Cloudflare resources

```bash
npx wrangler d1 create founderlive              # → database_id
npx wrangler kv namespace create RATE           # → id
npx wrangler r2 bucket create founderlive-media
```

Paste the D1 `database_id` and the KV `id` into your config. Then set:

| Field | Value |
|---|---|
| `routes[0].pattern` | The hostname the Worker will live on, e.g. `live.example.com`. Must be a zone on your account; `custom_domain: true` creates the DNS record and certificate on first deploy. |
| `vars.PUBLIC_BASE_URL` | `https://` + that hostname. Baked into the WebSocket URL, the call iframe and the embed snippet, so a wrong value looks like a CORS bug. |
| `vars.ORG_ID` | Any short slug naming your organization. Keep it stable forever: it names the Durable Object and the row that holds your intro clip. |
| `account_id` | Optional; wrangler asks otherwise. |

The Worker, D1 database and R2 bucket are named `founderlive` — the project's
internal name, which also appears in the widget's JavaScript API
(`FounderLive.init(...)`) and its DOM events. Renaming them is not necessary.

### 3. RealtimeKit

RealtimeKit is Cloudflare's hosted WebRTC. Create the app **in the dashboard**,
not through the API, so it comes with the default presets this code expects.

1. <https://dash.cloudflare.com/?to=/:account/realtime/kit> → **Create App** →
   copy the **App ID**.
2. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** with the
   **Realtime → RealtimeKit Admin** permission → copy the token.

**Preset names use underscores.** Cloudflare's docs show `group-call-host`, but
an app is actually created with `group_call_host` and `group_call_participant`,
which is what `wrangler.jsonc` ships with. A mismatch fails only at the moment
a real call is accepted, so after deploying check
`GET https://<your host>/api/host/realtimekit` (signed in): it lists the
presets your app really has and whether the configured names match.

### 4. Secrets

Secrets, never `vars` — a plaintext var of the same name silently overrides a
secret on deploy.

```bash
C=wrangler.prod.local.jsonc
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID  --config $C
npx wrangler secret put REALTIMEKIT_APP_ID     --config $C
npx wrangler secret put REALTIMEKIT_API_TOKEN  --config $C
npx wrangler secret put SESSION_SECRET         --config $C   # any long random string, e.g. openssl rand -base64 48
```

### 5. Schema and deploy

```bash
npx wrangler d1 migrations apply founderlive --remote --config $C
npm run deploy -- --config $C        # refuses template placeholders, then builds, typechecks, tests, deploys
```

Do **not** run `npm run db:seed:remote` unless you want the two example sites;
you will create your real sites on the dashboard. The local-only seed file with
the `dev@example.com` admin is never applied remotely.

### 6. Your first admin

There is no sign-up page, on purpose. Create the first admin from your
terminal; the password is printed once.

```bash
node scripts/agent.mjs add --name "Ada" --email ada@example.com --role admin --remote --config $C
```

Sign in at `https://<your host>/host`. On the **Embed** tab create a site, add
its domain, copy the snippet into your website. On the **Clip** tab record an
intro. On the **Agents** tab add your colleagues. Go live.

### Updating

```bash
git pull
npx wrangler d1 migrations apply founderlive --remote --config $C
npm run deploy -- --config $C
```

Deploy while nobody is live if you can: a deploy that changes the Durable
Object's stored state shape resets it (queue, presence), which is harmless
between conversations and abrupt during one.

---

## Agents and round-robin

One deployment is one organization with any number of **agents**. Each agent
has their own sign-in and their own live/paused/offline switch; the widgets
show the organization as live while *any* agent is.

| Assignment mode | What happens when someone joins the line |
|---|---|
| **Automatic** (default) | They are invited by the available agent who has gone longest since their last assignment. Ties break alphabetically by agent id. When that call ends, the next waiting person goes to the next agent in the rotation. |
| **Manual** | Nobody is invited until an agent presses **Accept** or **Accept next**. |

An agent is *available* when they are live, connected, not paused, and not in
a call or holding an invitation. Pausing takes you out of the rotation without
taking the team offline. If the agent who invited someone goes offline before
the call connects, the visitor goes back to the head of the line for the next
agent; if a call is already running it ends.

Every dashboard shows the whole queue plus each colleague's status and who they
are talking to; each agent's *own* call fills their main area. Wait estimates
shown to visitors divide by the number of live agents.

### Roles

| | agent | admin |
|---|---|---|
| Go live, take calls, see the queue, inbox and team | ✓ | ✓ |
| Record the intro clip | ✓ | ✓ |
| Change their own password | ✓ | ✓ |
| Sites, domains, per-site settings | | ✓ |
| Add agents, change roles, disable, reset passwords | | ✓ |

The last enabled admin cannot be demoted or disabled.

### The agent CLI

Everything the Agents tab does, from a terminal — including the first admin on
a fresh deployment. Without `--remote` it acts on the local dev database.

```
node scripts/agent.mjs add      --name "Ada" --email ada@example.com [--password ...] [--role admin] [--remote] [--config file]
node scripts/agent.mjs password --email ada@example.com [--password ...] [--remote]
node scripts/agent.mjs list     [--remote]
node scripts/agent.mjs disable  --email ada@example.com [--remote]
node scripts/agent.mjs enable   --email ada@example.com [--remote]
```

Passwords are stored as PBKDF2-SHA256 (100 000 iterations — the most the
Workers runtime allows — with a per-user salt); the
CLI and the Worker produce and verify the same format, which
`test/password.test.ts` proves.

---

## Authentication

`HOST_AUTH_MODE` in `wrangler.jsonc` picks one of two modes.

**`password`** (default). Each agent signs in with email and password; a
success is a signed `HttpOnly` cookie valid for 12 hours, rate-limited to 8
attempts per IP per 15 minutes. Disabling an agent takes effect on their next
request. Simple, and fine for a small team.

**`access`** — preferred if you already use Cloudflare Zero Trust. Put a
Cloudflare Access application in front of the hostname, **scoped to `/host*`
and `/ws/host` only** — a policy covering the whole hostname would challenge
`/widget.js`, `/embed/*`, `/ws/widget`, `/media/*`, `/call` and `/api/*`, which
visitors and embedding sites call unauthenticated, and the widget would stop
working everywhere. The Worker verifies the JWT Access injects (RS256 against
your team's published keys, `aud`, issuer, expiry) rather than trusting the
header, so a misrouted request cannot forge a session. Anyone the policy admits
becomes an agent on their first visit; the very first one becomes admin.

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --config $C   # yourteam.cloudflareaccess.com
npx wrangler secret put CF_ACCESS_AUD         --config $C   # the application's AUD tag
npx wrangler secret put ALLOWED_HOST_EMAIL    --config $C   # optional: comma-separated allow-list on top of the policy
```

`workers_dev` is `false` because a `*.workers.dev` hostname is an
unauthenticated route that bypasses any Access policy bound to the real domain.

Dashboard writes are refused when the browser reports them as cross-site
(`Sec-Fetch-Site` / `Origin`), on top of the `SameSite=Lax` cookie; dashboard
pages send `frame-ancestors 'none'`; and the two credentials published for
local development — the example `SESSION_SECRET` and the `dev@example.com`
admin — are refused outright unless `PUBLIC_BASE_URL` is localhost.

---

## Embedding

Sites are managed on the dashboard's **Embed** tab (admins): create one, add
its domains, copy the snippet.

```html
<script
  src="https://live.example.com/widget.js"
  data-site="my-site"
  data-position="bottom-right"
  defer
></script>
```

### Domains

A site lists **root domains**, not exact origins. Each root covers itself and
every subdomain over https: `example.com` admits `example.com`,
`www.example.com` and `app.example.com`. Entering `app.example.com` scopes a
site to that subtree. `www.` is stripped on entry; nothing else is.

Refused on purpose, pinned by `test/domains.test.ts`: lookalikes
(`evil-example.com`), the domain as a prefix of another (`example.com.attacker.net`),
plain `http://` on a real domain, bare registry suffixes (`com`, `co.uk`), and
multi-tenant hosting suffixes as roots (`github.io`, `pages.dev`, `vercel.app`,
`myshopify.com`… — a site *under* one, like `mysite.github.io`, is fine).
`localhost` is the one exception to https, on any port, for local development —
remove it from production sites.

A page on a domain that is not listed sees nothing: the widget refuses to load
rather than showing an error. Changes reach every edge within a minute.

### Per-site settings

| Setting | What it does |
|---|---|
| **Name in the widget** | The name in every line of copy — "… is live", "Talk to …". Empty means **Agent**. Agents' real names are never shown to visitors unless you put them here. |
| **When nobody is live** | *Show* renders the offline state with a leave-a-message form. *Hide* renders nothing at all — but stays connected, so the bubble appears the instant someone goes live. |
| **Enabled** | Off refuses every request for the site, including the widget itself. |

### JavaScript API and events

```js
FounderLive.init({ siteId: 'my-site', position: 'bottom-right' })
FounderLive.open(); FounderLive.close(); FounderLive.destroy()
FounderLive.getStatus()   // { presence, self, view }
```

Events fire on `window`, so a host page can feed them to its own analytics:

```
founderlive:ready          founderlive:queuejoined    founderlive:callstarted
founderlive:opened         founderlive:queueleft      founderlive:callended
founderlive:closed         founderlive:invited        founderlive:inviteexpired
founderlive:talkclicked    founderlive:offlinemessagesent
```

`widget.js` is completely static — no presence, no site config, not even the
base URL, which it derives from its own `script.src` — so it caches for an hour
while presence still changes in seconds.

### Content Security Policy

If an embedding site sets a CSP, it needs one origin:

```
script-src   https://live.example.com
connect-src  https://live.example.com wss://live.example.com
frame-src    https://live.example.com
img-src      https://live.example.com
media-src    https://live.example.com
```

The RealtimeKit SDK is re-served from `/sdk/` and the intro clip from `/media/`
so the widget never talks to anything else.

---

## The dashboard

| Tab | |
|---|---|
| **Live** | Your status and call, the queue with each person's site, question and wait, every colleague's status, today's numbers, and *Earlier today* — everyone who joined and what happened, including joins that expired while nobody was watching. |
| **Embed** | Sites, domains, per-site settings, snippets. Admins. |
| **Clip** | Record or upload the intro loop; device check. |
| **Inbox** | Every join request and offline message ever submitted, with who took the call. |
| **Agents** | The team, roles, add / disable / reset password; your own password. |

**Alerts.** While somebody is waiting and *you* are available, the dashboard
rings a chime every 20 seconds, flashes the tab title, and — if you allowed
notifications — posts one per arrival while the tab is hidden. It is quiet
during a call, while paused, and while offline; the **Sound** button mutes it
per browser. Browsers refuse to play sound until you have clicked something on
the page, so after a reload a banner says so; any click fixes it.

---

## The call

Runs in an iframe from your own origin inside the widget, with
`allow="camera; microphone"`, so the WebRTC SDK, the permissions and the call's
CSS stay on your origin rather than injected into a customer's page. The same
URL works opened top-level, which is the fallback offered when a browser
refuses camera access inside a cross-origin frame.

Camera and microphone are requested only when someone clicks **Join**, on a
screen whose only content is that request — a denial in Chrome is remembered
per origin, so one badly-timed prompt costs every future call.

**Screen sharing** from either side on any desktop browser; the share fills the
stage and the camera becomes a tile. **Remote audio is played by this code, not
the SDK** — the core RealtimeKit SDK hands over a raw track and plays nothing —
with a "Tap to hear" fallback where autoplay is blocked.

**"I can't hear you"** is fixed on whichever side has the wrong device, so both
sides get the same tools: a microphone meter on the preview screen before
joining, and in the call a settings button with microphone, camera and (in
Chrome, Edge and Firefox) speaker pickers, a meter of your own microphone, a
meter of what is arriving from the other person, a "mic off" label when their
microphone is not in the call, and a status line that says which it is ("Your
mic: on — Shure MVX2U. Them: arriving and playing"). The mute button reflects
what the SDK actually has, not what was asked for: a microphone the browser
refused, or that iOS handed over silent, shows as **off** on that person's own
screen with a one-tap "Turn it on", instead of only as "mic off" on the other
side.

**Device defaults.** The camera, microphone and speaker you pick — under the
dashboard's *Audio & video settings*, which also rings the chosen speaker so
you can tell it is the right one, or inside a call — are remembered per
browser and used for every call after that. Agents can also tick *skip this check next
time* to join the moment their devices are up. Nothing is stored on the
server: a device id only means something to the browser that issued it.

A meeting is created only when a call is accepted, never for people in the
queue, and exactly two participant tokens are minted, by the Durable Object.
No recording, no transcription, no third party in the room. `calls` records
who, which site, which agent, when, how long and why it ended; that list is
deliberately complete.

---

## Testing

```bash
npm test             # 85 unit tests: state machine (round-robin, races, timers), domains, alerts, passwords
npm run smoke        # 45 end-to-end checks against a running Worker: origins, sockets, queue, auto-assignment, D1
npm run smoke:sites  # 26 checks on site management, domain enforcement, per-site settings
npm run smoke:call   # 16 checks that create and tear down a REAL RealtimeKit meeting
npm run check        # build + typecheck (worker and browser) + unit tests; runs before every deploy
```

The smoke suites take `[baseUrl] [password] [email]` and refuse a non-localhost
target unless you add `--disruptive`: they take agents offline, drive the queue
and create a throwaway site, which disconnects anyone using the deployment.

`src/shared/machine.ts` is a pure reducer — `(state, command) → {state, effects}`
with no I/O, no clock and no randomness; `now` and every generated id arrive on
the command — so the whole product lifecycle, including three agents and two
concurrent calls, runs in milliseconds under test. The Durable Object is a shell
that persists, broadcasts and sets alarms.

---

## How it works

### One Durable Object

`LiveHostRoom`, addressed by `idFromName(ORG_ID)`. One organization means one
instance, which is what makes a single global queue across unrelated websites
possible: everyone lands in the same line because there is only one room.

Sockets are accepted with `ctx.acceptWebSocket`, so hundreds of idle widgets
cost nothing while the object hibernates. Consequences: no timers (every
deadline collapses into the single alarm slot, and `TICK` applies all of them at
once); no in-memory truth (state is read from storage and written back each
event); socket identity in `serializeAttachment`, not a `Map`. Keepalives are
answered by `setWebSocketAutoResponse` without waking the object.

### State

```
Agent     OFFLINE → AVAILABLE ⇄ PAUSED        (per agent; org presence = best agent)
                       ↕
                     BUSY

Visitor   BROWSING → WAITING → INVITED → CONNECTING → IN_CALL → COMPLETED
                        ↓         ↓                       ↓
                      LEFT     EXPIRED               VISITOR_LEFT
                             DECLINED
```

Each agent has an *intent* (what they asked for); their *status* is derived
from it plus reality — connected? in a call? holding an invitation? Storing the
derived value would let the two drift, which is how a widget ends up showing
LIVE for a dashboard that closed an hour ago.

### Races

The Durable Object handles one event at a time, so these are plain checks:

| Race | Resolution |
|---|---|
| Two agents accept the same visitor | The second sees the invitation and is told so |
| Visitor leaves as an agent accepts | Invitation and provisional call go with them; the agent is freed |
| Invitation expires as the visitor accepts | Deadline re-checked in the reducer, not left to the timer |
| Agent goes offline mid-invitation | Visitor returns to the head of the line for the next agent |
| A command is retried after a dropped socket | `commandId` ring buffer makes it a no-op |
| RealtimeKit fails to create the meeting | Visitor keeps their place; automatic assignment pauses for 30s rather than hammering a broken dependency, and an agent can still accept by hand |

### Presence and failure handling

| What happens | What we do |
|---|---|
| An agent closes the dashboard | 45s grace, then offline. The queue is released only when the *last* live agent goes |
| A visitor's tab is suspended | 90s grace; they keep their exact position if they return |
| Either side drops mid-call | 30s to reconnect before the call ends |
| Visitor accepts but never connects | 120s, then the call is abandoned and does not count |

### Wait estimates

Rolling average of the last 10 **connected** calls, divided by the number of
live agents, plus the remainder of the soonest-ending call in progress. Below
3 completed calls there is no estimate, just "2 people ahead of you". Estimates
are bucketed ("~5 min", "~10 min", "20+ min") because "~13 minutes" reads as a
promise.

### Embed security

`siteId` arrives from a script tag on a page you do not control, so it is a
claim. Every entry point that spends resources — opening a socket, joining the
queue, minting call credentials — validates it against the browser-supplied
`Origin`. Rate limits (KV, fixed window, fail open): sockets 60/min, joins
10/5 min, offline messages 5/hour, call credentials 20/5 min, sign-in 8/15 min.
The strongly-consistent limits — one queue entry per visitor, one call per
agent — live in the state machine.

---

## Layout

```
src/
  index.ts                  Worker entry; route registration
  config.ts                 every tunable number and every visitor-facing string
  types.ts                  bindings and D1 row shapes
  durable/LiveHostRoom.ts   the one coordinator: sockets, alarms, broadcasts
  shared/
    protocol.ts             the wire format, shared with client/
    machine.ts              the pure reducer — read this first
    domains.ts              the domain allow-list rules
    validation.ts           inbound parsing and sanitisation
  routes/                   host (dashboard + agent APIs), api, ws, call, media
  lib/                      auth, password, sites, db, realtimekit, ratelimit, analytics
  ui/styles.ts              dashboard and call page CSS

client/
  widget/                   the embeddable widget (shadow DOM, no framework)
  host/                     dashboard hydration, alerts, recorder
  call/                     RealtimeKit call UI
  shared/                   reconnecting WebSocket, chime

migrations/   D1 schema, applied in order
seed/         example sites (any environment) and the dev admin (local only)
scripts/      agent CLI, client build, demo server, smoke suites
test/         vitest
demo/         a pretend customer page for local development
```

`client/` imports types straight out of `src/shared/`: the protocol is defined
once and both ends of the wire are checked against it.

## Not built, on purpose

Public broadcasting, group calls, visitor-to-visitor chat, scheduling, visitor
accounts, recording, transcripts, SMS, CRM integrations, departments or skills
routing, payments. The reducer is one file where a routing rule would go, and
`queue_sessions` and `calls` already carry `site_id`, `visitor_id` and
`agent_id`.

## License

MIT — see [LICENSE](LICENSE).

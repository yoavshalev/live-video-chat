# Working on this repository with an AI coding agent

Read this before changing anything. It is short on purpose.

## What this is

A Cloudflare Workers app: an embeddable "talk to a person right now" video
widget with one shared queue and any number of agents. Hono + one Durable
Object (WebSocket hibernation) + D1 + KV + R2 + RealtimeKit for media. The
README explains the product and the setup; this file is about not breaking it.

## Where things are

```
src/shared/machine.ts      the state machine — a PURE reducer, (state, command) → {state, effects}
src/durable/LiveHostRoom.ts the one Durable Object: sockets, alarms, effects
src/routes/                 HTTP routes, one file per group
src/lib/                    auth, password, sites, db, realtimekit, ratelimit
client/widget, host, call   browser bundles (esbuild → src/generated, never edited by hand)
test/                       vitest; test/machine.test.ts is the one that matters most
scripts/                    agent CLI, build, deploy preflight, smoke suites
```

## Commands

```
npm install
npm run db:migrate && npm run db:seed   # local D1 + two example sites + dev@example.com / local-dev-password
npm run dev                             # Worker on :8787          npm run demo   # a customer page on :8788
npm run check                           # build + typecheck (worker AND browser) + unit tests — must pass before any commit
npm run smoke / smoke:sites / smoke:call   # end-to-end, against a RUNNING localhost Worker
npm run deploy -- --config wrangler.<name>.local.jsonc
```

## Rules that are easy to break

- **The reducer stays pure.** No `Date.now()`, no random ids, no I/O inside
  `src/shared/machine.ts`; `now` and `ids` arrive on the command. Every new
  transition gets a test in `test/machine.test.ts`. The Durable Object only
  persists, broadcasts, sets the single alarm and applies effects.
- **Identity comes from the socket, never the payload.** A message's `callId`
  or `visitorId` is checked against what the socket's attachment says, as
  `CALL_END` and `CALL_MEDIA_*` in `LiveHostRoom.ts` do.
- **`wrangler.jsonc` is a template.** Real account ids, D1/KV ids and
  hostnames live only in a gitignored `wrangler.*.local.jsonc`. Never commit
  them, and never put a secret in `vars`. `scripts/deploy.mjs` refuses
  placeholders for this reason.
- **No personal data in tracked files.** Sites, domains, emails and names in
  seeds, tests, docs and comments are `example.com`-style. Run
  `git grep -i` for anything real before opening a PR.
- **Browser code builds DOM with `textContent`/`createElement`.** No
  `innerHTML` with anything that came from a visitor or an agent.
- **PBKDF2 stays ≤ 100 000 iterations** — the Workers runtime refuses more,
  and local `wrangler dev` does not enforce it, so a higher number passes
  every local test and fails the first real login.
- **RealtimeKit presets use underscores** (`group_call_host`). The SDK is
  served from `/sdk/…` on our origin; do not add another script host — the
  widget's whole CSP story is "one origin".
- **Smoke suites disrupt a live deployment** (they take agents offline). They
  refuse a non-localhost target without `--disruptive`; do not add that flag
  to any script or CI step.
- **Line endings are LF** (`.gitattributes`, `.editorconfig`). On Windows,
  Python's text mode writes CRLF; write files in binary mode or with
  `newline=''`.
- **`src/generated/` is build output.** Edit `client/`, run `npm run check`.
- Comments explain *why*, in full sentences; match the density of the file
  you are in. Do not add attribution comments or change formatting elsewhere.

## Before you finish

1. `npm run check` is green.
2. If you touched sockets, routes or the reducer: `npm run smoke` (and
   `smoke:sites` for site management) against `npm run dev`.
3. `git status` shows no `.dev.vars`, no `wrangler.*.local.jsonc`, no ids.
4. The README still describes what the code does.

# Contributing to Live Video Chat

Thanks for being here. Whether you deployed it once, found a bug on an iPhone,
or want to add a feature — you are welcome, and first-time contributors
especially so.

## Ways to help (most don't need code)

- **Tell us it works (or doesn't).** Deployed it? Open a
  [Discussion](https://github.com/yoavshalev/live-video-chat/discussions) with your browser/device mix and what you
  used it for. Real-world reports are the most useful thing we get.
- **Report a bug** with the [bug form](https://github.com/yoavshalev/live-video-chat/issues/new/choose). Device,
  browser and "what you clicked" matter more than anything else — media bugs
  are almost always device-specific.
- **Improve the docs.** If a README step confused you, the fix is probably a
  one-line PR. Typos and clarifications are merged gladly.
- **Pick up an issue** labelled
  [`good first issue`](https://github.com/yoavshalev/live-video-chat/labels/good%20first%20issue) or
  [`help wanted`](https://github.com/yoavshalev/live-video-chat/labels/help%20wanted). Comment on it first so nobody
  duplicates work.
- **Test on hardware we don't have** — older Android phones, Safari versions,
  corporate networks behind strict firewalls.

## Before you build something big

Open an issue or Discussion first and describe the idea in a paragraph. It
saves you from writing code that can't be merged.

This project is intentionally small. The README has a
[**Not built, on purpose**](README.md#not-built-on-purpose) list (group calls,
recording, scheduling, CRM integrations, payments…). Those aren't "never" —
but they need a conversation about design first, and many belong in a fork or
a plugin rather than in core.

## Local setup

You need Node 20+ and a free Cloudflare account (only for `smoke:call`, which
creates a real RealtimeKit meeting).

```bash
git clone https://github.com/<you>/live-video-chat.git
cd live-video-chat
npm install
cp .dev.vars.example .dev.vars          # fill in what you need
npm run db:migrate && npm run db:seed   # local D1, two example sites, dev@example.com / local-dev-password
npm run dev                             # Worker on :8787
npm run demo                            # a pretend customer page on :8788
```

## Making a change

1. Fork, then branch from `main` (`fix/ios-mic-resume`, `docs/csp-example`…).
2. Read [`AGENTS.md`](AGENTS.md). It's short, and it lists the rules that are
   easy to break. It applies to humans too. The big ones:
   - The reducer in `src/shared/machine/` stays **pure** — no clock, no random
     ids, no I/O. Every new transition gets a test in `test/machine.test.ts`.
   - **Identity comes from the socket, never the payload.**
   - Browser code builds DOM with `textContent` / `createElement` — never
     `innerHTML` with visitor or agent input.
   - `wrangler.jsonc` must stay deployable untouched by the Deploy button.
   - `src/generated/` is build output; edit `client/` instead.
   - No real names, emails, domains or ids anywhere — use `example.com`.
3. Run the checks:
```bash
   npm run check          # build + typecheck (worker and browser) + unit tests — must be green
   npm run smoke          # if you touched sockets, routes or the reducer (needs `npm run dev` running)
   npm run smoke:sites    # if you touched site management
```
   Never point the smoke suites at someone's live deployment.
4. Keep the PR focused: one change, no unrelated formatting. Update the README
   if behaviour changed.
5. Open the PR and fill in the template. Screenshots or a short screen
   recording are very welcome for anything visible.

## Using AI coding agents

Fine by us — Claude Code, Codex, Cursor and friends all read `AGENTS.md`.
You are still the author: read the diff, run the checks, and be ready to
explain the change in review.

## Style

- TypeScript, LF line endings, formatting per `.editorconfig`.
- Comments explain *why*, in full sentences, matching the file around them.
- Small files with one job; follow the existing layout (one file per tab,
  per screen, per concern).

## Review

This is maintained by one person, so reviews can take a few days. A friendly
ping on the PR after a week is fine. Small, tested, focused PRs get merged
fastest. If a PR isn't a fit, you'll get a reason, not silence.

## License

By contributing you agree that your contribution is licensed under the
project's [MIT License](LICENSE).

## Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

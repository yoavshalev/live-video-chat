# Security Policy

Live Video Chat puts a widget on other people's websites, handles camera and
microphone access, and mints call credentials — so security reports are
taken seriously and handled first.

## Supported versions

Only the latest commit on `main` receives security fixes. If you deployed
with the Deploy button, update as described in the README's
[Updating](README.md#updating) section.

## Reporting a vulnerability

**Please do not open a public issue, PR or Discussion for a security problem.**

Report it privately through GitHub:
**Security → [Report a vulnerability](https://github.com/yoavshalev/live-video-chat/security/advisories/new)**.

Please include:

- What the issue is and what an attacker could do with it
- Steps to reproduce, or a proof of concept against a **local** deployment
  (`npm run dev`)
- Affected files or routes, if you know them
- Any suggested fix

## What to expect

- Acknowledgement within **3 business days**
- An initial assessment within **7 days**
- A fix, or a clear plan, as quickly as severity allows; we'll keep you
  updated along the way
- Credit in the advisory and release notes, if you'd like it

Please give us a reasonable window to ship a fix before disclosing publicly —
we aim for 90 days at most, and usually much less.

## In scope

Things we especially want to hear about:

- Bypassing the `siteId` / `Origin` check, or embedding the widget on a
  domain that isn't allow-listed
- A visitor or agent acting as someone else (identity must come from the
  socket, never the message payload)
- Joining, watching or hijacking a call you weren't invited to; leaking
  RealtimeKit tokens
- Authentication, session, CSRF or Cloudflare Access bypasses on the dashboard
- XSS in the widget, dashboard or call page
- Getting around rate limits in a way that enables abuse or runaway cost
- Leaking visitor data (names, emails, messages) across sites or to other
  visitors

## Out of scope

- Attacks against deployments you don't own — test locally only, and never
  run the smoke suites with `--disruptive` against someone else's site
- Denial of service by sheer volume, or social engineering
- Vulnerabilities in Cloudflare's own platform (report those to
  [Cloudflare](https://hackerone.com/cloudflare))
- Missing headers or best-practice notes with no demonstrated impact
- Issues in a fork that has modified the security-relevant code

## Safe harbour

Good-faith research that follows this policy — local testing, no data
access beyond what's needed to demonstrate the issue, no disruption to
others — won't face any action from us, and we'll thank you for it.

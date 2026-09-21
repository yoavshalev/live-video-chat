/**
 * The 1:1 call surface. One page, used by both sides.
 *
 * Normally this is loaded in a same-origin iframe inside the widget (visitor) or
 * the dashboard (host), with `allow="camera; microphone"`. That is what keeps the
 * promise of never leaving the website while also keeping a megabyte of WebRTC
 * SDK off the embedding site's page — the iframe is ours, so the SDK, the styles
 * and the media permissions all belong to this origin, not to the customer's.
 *
 * The same URL also works opened top-level, which is the fallback when a browser
 * refuses camera access inside a cross-origin frame. That fallback is the reason
 * the page takes its parameters from the query string rather than only over
 * postMessage.
 *
 * The call secret travels in that query string, so this page is served
 * `no-store` and `no-referrer`: it must not sit in a shared cache and the secret
 * must not ride along to any third party the page happens to touch.
 */

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import type { AppEnv } from '../types'
import { BASE_STYLES, CALL_STYLES } from '../ui/styles'
import { SDK_PATH } from './sdk'
import { isSafeId, LIMITS } from '../shared/validation'
import { frameAncestorsFor, getSite } from '../lib/sites'
import { originAllowed } from '../shared/domains'
import callAppSource from '../generated/call.js'

/**
 * A fingerprint of the bundle, appended to its URL as `?v=`. The script is
 * cached for a day, which is fine because a new build has a new URL — so a fix
 * to the call page reaches the next call, not the call after the cache expires.
 * The page itself is `no-store`, so it always references the current version.
 */
const CALL_APP_VERSION = (() => {
  let hash = 2166136261
  for (let i = 0; i < callAppSource.length; i++) {
    hash ^= callAppSource.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
})()

export function register(app: Hono<AppEnv>): void {
  app.get('/call/app.js', (c) =>
    c.body(callAppSource, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, immutable'
    })
  )

  app.get('/call', async (c) => {
    const callId = c.req.query('callId') ?? ''
    const secret = c.req.query('secret') ?? ''
    const who = c.req.query('who') === 'host' ? 'host' : 'visitor'
    const visitorId = c.req.query('visitorId') ?? ''
    const name = c.req.query('name') ?? ''
    const siteId = c.req.query('siteId') ?? ''
    const claimedParent = c.req.query('origin') ?? ''

    // Shape-check before rendering. Credentials are still checked properly by
    // /api/call/credentials; this only avoids rendering a page that cannot work.
    if (!isSafeId(callId, 64) || secret.length < 16) {
      return c.html(
        errorPage('This call link is not valid.', 'Close this and use the button in the widget again.'),
        400,
        { 'Cache-Control': 'no-store' }
      )
    }
    if (who === 'host' && !c.get('agent')) {
      return c.html(errorPage('Not signed in.', 'Sign in to the dashboard, then rejoin the call.'), 401, {
        'Cache-Control': 'no-store'
      })
    }

    // WHO MAY FRAME THIS PAGE, and where postMessage may be sent.
    //
    // The widget lives on a customer site and frames us cross-origin, so
    // `frame-ancestors 'self'` alone would break the product. Instead the exact
    // origins configured for the sites are listed — the same allow-list that
    // guards every other embed entry point, reused so there is one answer to
    // "which origins are ours" rather than two that can drift.
    //
    // A visitor's call is framed by the widget on ONE site, so only that site's
    // domains may frame it — and without a siteId, nobody may. An agent's call
    // is framed by the dashboard, which is us. Listing every site's domains for
    // every call would let one customer's page frame another customer's call.
    const selfOrigin = new URL(c.env.PUBLIC_BASE_URL).origin
    const site = who === 'visitor' && siteId ? await getSite(c.env, siteId) : null
    const domains = site?.enabled ? site.allowedDomains : []
    const frameOrigins = frameAncestorsFor(domains)

    // Only an origin the widget could legitimately be running on becomes a
    // postMessage target; anything else falls back to no parent, which makes the
    // call page use its HTTP path instead of shouting at '*'.
    const parentOrigin =
      who === 'host'
        ? claimedParent === selfOrigin
          ? selfOrigin
          : null
        : claimedParent && originAllowed(claimedParent, domains)
          ? claimedParent
          : null

    const boot = {
      callId,
      secret,
      who,
      visitorId: isSafeId(visitorId, LIMITS.visitorId) ? visitorId : null,
      peerName: name.replace(/[<>]/g, '').slice(0, 40),
      sdkUrl: SDK_PATH,
      parentOrigin
    }

    return c.html(
      html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
    <title>Call</title>
    <style>
      ${raw(BASE_STYLES)}
      ${raw(CALL_STYLES)}
    </style>
  </head>
  <body>
    <div class="call">
      <div class="stage" id="stage">
        <video id="remote" class="remote" autoplay playsinline></video>
        <!-- The other side's screen. When it is live the stage goes into
             "sharing" mode: this fills it and their camera drops to a tile. -->
        <video id="share" class="share hidden" autoplay playsinline muted></video>
        <video id="local" class="local hidden" autoplay playsinline muted></video>
        <div id="peer-name" class="peer-name hidden"></div>
        <div id="peer-hint" class="peer-hint hidden" role="status"></div>
        <div id="share-pill" class="share-pill hidden">You are sharing your screen</div>
        <!-- The other side's AUDIO. The core SDK hands over a raw audio track and
             plays nothing itself — registerVideoElement attaches video only. A call
             without this element is a silent film, which is exactly what it was.
             Two elements, because a screen share can carry its own audio. -->
        <audio id="remote-audio" autoplay></audio>
        <audio id="share-audio" autoplay></audio>
        <!-- Shown only if the browser refuses to start audio without a gesture. -->
        <button id="btn-hear" class="hear hidden" type="button">Tap to hear</button>

        <!-- Our microphone is off and nobody asked for that: the browser refused
             it, or the device handed over silence. Said here, on the screen of
             the person who can fix it, not only as "mic off" on the other side. -->
        <div id="mic-off" class="mic-off hidden" role="alert">
          <span id="mic-off-text">Your microphone is off.</span>
          <button id="mic-off-fix" class="btn-primary" type="button">Turn it on</button>
        </div>

        <!-- In-call audio and video settings. Both sides get this, because "I
             can't hear you" is fixed on whichever side has the wrong device, and
             the meters say which side that is. -->
        <div id="settings" class="settings hidden" role="dialog" aria-label="Audio and video settings">
          <div class="between">
            <strong>Audio &amp; video</strong>
            <button id="settings-close" class="btn-ghost" type="button">Done</button>
          </div>
          <p id="audio-status" class="tiny" style="margin:0"></p>
          <div>
            <label for="call-mic">Microphone</label>
            <select id="call-mic"></select>
            <div class="level-row"><span id="mic-level-label" class="tiny muted">You — say something</span><div class="level"><i id="mic-level"></i></div></div>
          </div>
          <div id="speaker-wrap" class="hidden">
            <label for="call-speaker">Speaker</label>
            <div class="row">
              <select id="call-speaker" style="flex:1;min-width:0"></select>
              <button id="call-speaker-test" class="btn-ghost" type="button">Test</button>
            </div>
          </div>
          <div>
            <div class="level-row"><span class="tiny muted" id="remote-level-label">Them</span><div class="level remote"><i id="remote-level"></i></div></div>
            <p class="tiny muted" style="margin:6px 0 0">If their bar moves and you hear nothing, change your speaker. If it stays flat, they need to check their microphone.</p>
          </div>
          <div>
            <label for="call-cam">Camera</label>
            <select id="call-cam"></select>
          </div>
          <label id="auto-join-call-wrap" class="check tiny muted hidden"><input id="auto-join-call" type="checkbox" /> Join right away next time, without the camera check</label>
          <p id="settings-hint" class="tiny muted" style="margin:0"></p>
        </div>
        <div id="timer" class="timer hidden"><span class="dot busy" aria-hidden="true"></span><span id="elapsed" class="mono">0:00</span></div>

        <!-- The AV check. Camera and microphone are requested HERE and nowhere
             earlier: a permission prompt that appears while someone is still
             reading gets denied, and a denial is sticky. -->
        <div id="overlay" class="overlay">
          <div class="inner">
            <h1 id="overlay-title">Getting ready…</h1>
            <p id="overlay-body" class="muted small" style="margin:0"></p>

            <video id="preview" class="local setup hidden" autoplay playsinline muted></video>

            <div id="device-row" class="device-row hidden">
              <div>
                <label for="camera-select">Camera</label>
                <select id="camera-select"></select>
              </div>
              <div>
                <label for="mic-select">Microphone</label>
                <select id="mic-select"></select>
                <!-- Moves when the chosen microphone hears you. The cheapest
                     possible answer to "is my mic working?" before anyone joins. -->
                <div class="level-row"><span id="preview-label" class="tiny muted">Say something</span><div class="level"><i id="preview-level"></i></div></div>
              </div>
              <div id="preview-speaker-wrap" class="hidden">
                <label for="preview-speaker">Speaker</label>
                <div class="row">
                  <select id="preview-speaker" style="flex:1;min-width:0"></select>
                  <button id="preview-speaker-test" class="btn-ghost" type="button">Test</button>
                </div>
                <div id="preview-speaker-hint" class="tiny muted"></div>
              </div>
              <!-- Agents only (shown from the client): skip this screen next time. -->
              <label id="auto-join-wrap" class="check tiny muted hidden"><input id="auto-join" type="checkbox" /> Skip this check next time and join right away (this browser)</label>
            </div>

            <div id="overlay-error" class="error-box hidden"></div>

            <div id="overlay-actions" class="actions">
              <button id="btn-join" class="btn-primary hidden" type="button">Join the call</button>
              <button id="btn-retry" class="btn-ghost hidden" type="button">Try again</button>
              <!-- Without this a failed call is a dead end: the widget hides its
                   own close control during a call, so an error screen with only
                   "Try again" traps the visitor inside it. -->
              <button id="btn-abandon" class="btn-ghost hidden" type="button">Leave</button>
              <a id="btn-newtab" class="btn-ghost hidden" style="text-decoration:none;display:inline-block;padding:9px 14px;border:1px solid var(--border);border-radius:10px" target="_blank" rel="noopener">Open in a new tab</a>
            </div>
          </div>
        </div>
      </div>

      <div class="controls" id="controls" hidden>
        <button id="btn-mic" class="ctrl" type="button" aria-label="Mute microphone" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>
          <span id="mic-label" class="ctrl-label">Mute</span>
        </button>
        <button id="btn-cam" class="ctrl" type="button" aria-label="Turn camera off" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          <span class="ctrl-label">Camera</span>
        </button>
        <!-- Hidden on browsers without getDisplayMedia (every mobile browser). -->
        <button id="btn-share" class="ctrl hidden" type="button" aria-label="Share your screen" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 13V8M9 11l3-3 3 3"/></svg>
          <span class="ctrl-label">Share</span>
        </button>
        <button id="btn-settings" class="ctrl" type="button" aria-label="Audio and video settings" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>
          <span class="ctrl-label">Settings</span>
        </button>
        <button id="btn-leave" class="ctrl end" type="button">End call</button>
      </div>
    </div>

    <script type="application/json" id="boot">${raw(JSON.stringify(boot))}</script>
    <script type="module" src="/call/app.js?v=${CALL_APP_VERSION}"></script>
  </body>
</html>`,
      200,
      {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `frame-ancestors 'self' ${frameOrigins.join(' ')}`.trim()
      }
    )
  })
}

function errorPage(title: string, body: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <style>
      ${raw(BASE_STYLES)}
      .wrap { display: grid; place-items: center; min-height: 100vh; padding: 24px; text-align: center; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="stack" style="max-width:360px">
        <h1>${title}</h1>
        <p class="muted small" style="margin:0">${body}</p>
      </div>
    </div>
  </body>
</html>`
}

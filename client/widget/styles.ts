/**
 * The widget's stylesheet, injected into a shadow root.
 *
 * Isolation is the whole point. Inside a shadow root nothing the embedding site
 * declares reaches these rules and nothing here escapes, so PingBell's reset and
 * SYQEL's dark theme cannot break the widget and the widget cannot break them.
 * That is also why there is no `:root` here and no global selectors — `:host` is
 * the boundary.
 *
 * `all: initial` on :host is the belt to that suspenders: it stops inherited
 * properties (font, line-height, color, direction) from crossing the shadow
 * boundary, which they otherwise do.
 */

export const WIDGET_STYLES = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483000;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  color-scheme: dark;

  --fl-bg: #101215;
  --fl-surface: #191c21;
  --fl-border: #2a2f37;
  --fl-text: #f3f5f8;
  --fl-muted: #98a1b0;
  --fl-accent: #5b8cff;
  --fl-accent-ink: #fff;
  --fl-live: #2fd47a;
  --fl-busy: #ffb020;
  --fl-danger: #ff5a52;
  --fl-shadow: 0 2px 6px rgba(0,0,0,.28), 0 16px 48px rgba(0,0,0,.34);
}

:host([data-position="bottom-right"]) { right: 18px; bottom: 18px; }
:host([data-position="bottom-left"]) { left: 18px; bottom: 18px; }
:host([data-theme="light"]) {
  color-scheme: light;
  --fl-bg: #ffffff;
  --fl-surface: #f7f8fa;
  --fl-border: #e3e6ec;
  --fl-text: #10131a;
  --fl-muted: #5c6474;
  --fl-shadow: 0 2px 6px rgba(16,19,26,.07), 0 16px 48px rgba(16,19,26,.13);
}

*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; cursor: pointer; border: 0; background: none; color: inherit; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--fl-accent);
  outline-offset: 2px;
}

/* ── Collapsed bubble ───────────────────────────────────────────────────── */

.bubble {
  display: flex; align-items: center; gap: 9px;
  background: var(--fl-bg); color: var(--fl-text);
  border: 1px solid var(--fl-border); border-radius: 999px;
  padding: 9px 16px 9px 11px;
  box-shadow: var(--fl-shadow);
  font-size: 14px; font-weight: 550; letter-spacing: -.01em;
  transition: transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s ease;
  max-width: min(84vw, 300px);
}
.bubble:hover { transform: translateY(-1px); }
.bubble .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bubble .count { color: var(--fl-muted); font-weight: 450; }

.avatar {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  object-fit: cover; background: var(--fl-surface);
  display: grid; place-items: center; font-size: 12px; font-weight: 600; color: var(--fl-muted);
}

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--fl-muted); }
.dot.available { background: var(--fl-live); animation: fl-pulse 2.4s infinite; }
.dot.busy, .dot.paused { background: var(--fl-busy); }
.dot.offline { background: #616a78; }

@keyframes fl-pulse {
  0% { box-shadow: 0 0 0 0 rgba(47,212,122,.5); }
  70% { box-shadow: 0 0 0 8px rgba(47,212,122,0); }
  100% { box-shadow: 0 0 0 0 rgba(47,212,122,0); }
}

/* ── Expanded panel ────────────────────────────────────────────────────── */

.panel {
  position: relative;
  width: min(92vw, 352px);
  background: var(--fl-bg); color: var(--fl-text);
  border: 1px solid var(--fl-border); border-radius: 18px;
  box-shadow: var(--fl-shadow); overflow: hidden;
  animation: fl-rise .18s cubic-bezier(.2,.8,.3,1);
}
@keyframes fl-rise { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }

/*
 * The close control floats over the panel rather than sitting in a header row,
 * so the intro clip can run edge to edge at the top. Its own translucent
 * backdrop keeps it legible over both the clip and a plain surface.
 */
.panel-head { position: absolute; top: 9px; right: 9px; z-index: 5; }
.close {
  width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  color: #fff;
  background: rgba(8,10,13,.55);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,.14);
}
.close:hover { background: rgba(8,10,13,.8); }
:host([data-theme="light"]) .close { color: var(--fl-text); background: rgba(255,255,255,.7); border-color: rgba(0,0,0,.1); }

.body { padding: 16px; display: grid; gap: 12px; }

/* Mobile only — see the media query at the end of this file. */
.sheet-grab {
  display: none;
  width: 100%; padding: 10px 0 4px;
  align-items: center; justify-content: center;
  color: var(--fl-muted);
}
.scrim { display: none; }
/* Forms live inside .body, so they carry the gap but not the padding again. */
.form { display: grid; gap: 12px; }
.title { font-size: 17px; font-weight: 640; letter-spacing: -.015em; margin: 0; }
.text { font-size: 14px; line-height: 1.5; color: var(--fl-muted); margin: 0; }
.text strong { color: var(--fl-text); font-weight: 600; }

/* ── The intro clip ────────────────────────────────────────────────────── */
/*
 * The clip is a recording and the UI must never suggest otherwise. The ".clip-note" line
 * under the clip says so in words; the LIVE pill sits over it but is worded as a
 * statement about the person ("Live now"), not a label on the picture.
 */
.clip {
  position: relative; background: #0b0d10; aspect-ratio: 16 / 10; overflow: hidden;
  margin: -16px -16px 0;
}
.clip video, .clip img { width: 100%; height: 100%; object-fit: cover; display: block; }
.clip .fallback {
  position: absolute; inset: 0; display: grid; place-items: center; gap: 10px;
  background: linear-gradient(145deg, #1a1f2b 0%, #0f1319 100%); color: var(--fl-muted);
  font-size: 13px; text-align: center; padding: 16px;
}
.clip-pill {
  position: absolute; top: 10px; left: 10px;
  display: flex; align-items: center; gap: 6px;
  background: rgba(8,10,13,.82);
  border: 1px solid rgba(255,255,255,.12); border-radius: 999px;
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  letter-spacing: .05em; text-transform: uppercase; color: #fff;
}
.clip-sound {
  position: absolute; right: 10px; bottom: 10px;
  width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(8,10,13,.82);
  border: 1px solid rgba(255,255,255,.12); color: #fff;
}
.clip .fallback .avatar { width: 46px; height: 46px; font-size: 19px; }
.clip-note { font-size: 11px; color: var(--fl-muted); margin: 0; }

/* ── Controls ──────────────────────────────────────────────────────────── */

.btn {
  display: block; width: 100%; text-align: center;
  padding: 12px 16px; border-radius: 11px;
  font-size: 15px; font-weight: 620; letter-spacing: -.01em;
  background: var(--fl-surface); color: var(--fl-text); border: 1px solid var(--fl-border);
  transition: transform .12s ease, background .12s ease;
}
.btn:hover:not(:disabled) { transform: translateY(-1px); }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn.primary { background: var(--fl-accent); color: var(--fl-accent-ink); border-color: var(--fl-accent); }
.btn.primary:hover:not(:disabled) { background: #6f9bff; }
.btn.quiet { background: transparent; font-weight: 500; font-size: 14px; padding: 9px; color: var(--fl-muted); }
.btn.quiet:hover { color: var(--fl-text); }
.btn.danger { background: var(--fl-danger); color: #2a0503; border-color: var(--fl-danger); }

label { display: block; font-size: 12px; color: var(--fl-muted); margin-bottom: 5px; }
input, textarea {
  font: inherit; width: 100%; padding: 10px 12px;
  color: var(--fl-text); background: var(--fl-surface);
  border: 1px solid var(--fl-border); border-radius: 10px;
}
input::placeholder, textarea::placeholder { color: var(--fl-muted); opacity: .7; }
textarea { resize: vertical; min-height: 74px; }
.field-error { color: var(--fl-danger); font-size: 12px; margin: 4px 0 0; }
.consent { font-size: 11px; line-height: 1.45; color: var(--fl-muted); margin: 0; }

/* ── Waiting ───────────────────────────────────────────────────────────── */

.position { display: flex; align-items: baseline; gap: 10px; }
.position .n { font-size: 34px; font-weight: 680; letter-spacing: -.03em; line-height: 1; }
.eta { font-size: 13px; color: var(--fl-muted); }
.hint {
  font-size: 12px; color: var(--fl-muted);
  background: var(--fl-surface); border: 1px solid var(--fl-border);
  border-radius: 9px; padding: 9px 11px; margin: 0;
}

/* ── Your turn ─────────────────────────────────────────────────────────── */

.ready { border: 1px solid var(--fl-live); border-radius: 12px; padding: 13px; display: grid; gap: 9px; }
.countdown { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--fl-muted); }
.countdown.urgent { color: var(--fl-danger); font-weight: 600; }
.ring {
  height: 3px; border-radius: 999px; background: var(--fl-border); overflow: hidden;
}
.ring > i { display: block; height: 100%; background: var(--fl-live); transition: width 1s linear; }

/* ── In call ───────────────────────────────────────────────────────────── */
/*
 * Full-bleed: the call replaces the panel rather than sitting inside it. On a
 * phone it takes the viewport, because a video call in a 352px card is not a
 * conversation.
 */
.call-frame { width: 100%; height: 100%; border: 0; display: block; background: #000; }
:host([data-mode="call"]) .panel { width: min(94vw, 420px); height: min(78vh, 620px); display: grid; grid-template-rows: 1fr; }
:host([data-mode="call"]) .body { padding: 0; height: 100%; }

/* ── Phones ──────────────────────────────────────────────────────────────────
 *
 * The panel becomes a bottom sheet rather than a floating card. A card anchored
 * to "bottom" with no "top" grows upward off the screen once its content is
 * taller than the viewport, and the overflow is simply cut off with no way to
 * scroll to it — which is what "crammed to the top" was.
 *
 * The sheet is capped in height, scrolls internally, and sits above a scrim.
 */
@media (max-width: 560px) {
  :host([data-mode="collapsed"]) { right: 12px; left: 12px; bottom: 12px; }
  .bubble { max-width: none; width: fit-content; }
  :host([data-mode="collapsed"][data-position="bottom-left"]) .bubble { margin-right: auto; }
  :host([data-mode="collapsed"][data-position="bottom-right"]) .bubble { margin-left: auto; }

  /* An open panel owns the viewport. */
  :host([data-mode="panel"]), :host([data-mode="call"]) { inset: 0; right: 0; left: 0; bottom: 0; }

  .scrim {
    display: block; position: absolute; inset: 0;
    background: rgba(4,5,7,.55);
    animation: fl-fade .18s ease-out;
  }
  @keyframes fl-fade { from { opacity: 0 } to { opacity: 1 } }

  :host([data-mode="panel"]) .panel {
    position: absolute; left: 0; right: 0; bottom: 0;
    width: auto;
    /* dvh tracks the iOS URL bar; vh does not, and is the fallback. */
    max-height: 92vh;
    max-height: 92dvh;
    border-radius: 20px 20px 0 0;
    border-bottom: 0;
    display: flex; flex-direction: column;
  }
  :host([data-mode="panel"]) .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    /* Clear of the home indicator. */
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
  :host([data-mode="panel"]) .clip { margin-top: 0; flex: none; }

  /* The chevron replaces the round close button: bigger target, and it reads as
     "put this away" rather than "dismiss a dialog". */
  .sheet-grab { display: flex; }
  .panel-head { display: none; }

  /* A call takes the whole screen, safe areas included. */
  :host([data-mode="call"]) .panel {
    position: absolute; inset: 0;
    width: auto; height: auto;
    border-radius: 0; border: 0;
    display: flex; flex-direction: column;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  :host([data-mode="call"]) .body { padding: 0; flex: 1 1 auto; min-height: 0; }
  :host([data-mode="call"]) .scrim { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.hidden { display: none !important; }
`

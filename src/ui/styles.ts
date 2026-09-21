/**
 * Styles for the two first-party pages — the dashboard and the call surface.
 *
 * The widget does NOT use this. It ships its own stylesheet inside a shadow root
 * (client/widget/styles.ts) because it lives on pages whose CSS we do not
 * control and must neither inherit from nor leak into them.
 *
 * Design intent: quiet, dense, high-contrast. The dashboard is a control surface
 * someone stares at while a stranger waits, so state has to be readable at a
 * glance and destructive actions have to look different from safe ones. Dark by
 * default because that is what a call preview sits in comfortably.
 */

export const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  color-scheme: dark;
  --bg: #0a0b0d;
  --surface: #141619;
  --surface-2: #1c1f24;
  --border: #282c33;
  --text: #f2f4f7;
  --muted: #98a1b0;
  --accent: #5b8cff;
  --accent-ink: #ffffff;
  --live: #2fd47a;
  --busy: #ffb020;
  --danger: #ff5a52;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
  --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
}

html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  /* Phones put a rounded corner and a home indicator where content would be. */
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 20px; }
h2 { font-size: 15px; }

button {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 10px;
  padding: 9px 14px;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
button:hover:not(:disabled) { background: #22262d; }
button:disabled { opacity: .45; cursor: not-allowed; }
/* Focus is never removed, only made to match the design. Every control here is
   reachable and operable from the keyboard. */
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.btn-primary:hover:not(:disabled) { background: #6f9bff; }
.btn-live { background: var(--live); border-color: var(--live); color: #06240f; font-weight: 600; }
.btn-live:hover:not(:disabled) { background: #46e08c; }
.btn-danger { background: var(--danger); border-color: var(--danger); color: #2a0503; font-weight: 600; }
.btn-danger:hover:not(:disabled) { background: #ff7a73; }
.btn-ghost { background: transparent; }

input, textarea, select {
  font: inherit;
  width: 100%;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
}
textarea { resize: vertical; min-height: 84px; }
label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.muted { color: var(--muted); }
.small { font-size: 13px; }
.tiny { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.row { display: flex; align-items: center; gap: 10px; }
.between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.stack { display: grid; gap: 10px; }
.hidden { display: none !important; }

/* Status dot. The pulse is reserved for LIVE so that motion in the corner of the
   eye means exactly one thing. */
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.available { background: var(--live); box-shadow: 0 0 0 0 rgba(47,212,122,.6); animation: pulse 2.4s infinite; }
.dot.busy { background: var(--busy); }
.dot.paused { background: var(--busy); }
.dot.offline { background: #5a616e; }

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(47,212,122,.55); }
  70% { box-shadow: 0 0 0 9px rgba(47,212,122,0); }
  100% { box-shadow: 0 0 0 0 rgba(47,212,122,0); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`

export const HOST_STYLES = `
.shell { max-width: 1180px; margin: 0 auto; padding: 20px 20px 64px; }

header.top {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; padding-bottom: 18px; margin-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.01em; }
.status-label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
.tabs { display: flex; gap: 4px; padding: 3px; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; }
.tab { border: 0; background: transparent; color: var(--muted); padding: 7px 14px; border-radius: 8px; font-weight: 600; font-size: 14px; }
.tab[aria-selected="true"] { background: var(--surface-2); color: var(--text); }
.tab:hover:not([aria-selected="true"]) { color: var(--text); background: transparent; }
.tab-panel { animation: tab-in .14s ease-out; }
@keyframes tab-in { from { opacity: 0; transform: translateY(3px) } to { opacity: 1; transform: none } }

/* ── Live tab ─────────────────────────────────────────────────────────────── */
.live-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr); gap: 18px; align-items: start; }
@media (max-width: 960px) { .live-grid { grid-template-columns: 1fr; } }

/* The main area when nobody is on the line: a status, not a hole. */
.idle { min-height: 340px; display: grid; place-items: center; text-align: center; }
.idle-inner { display: grid; gap: 10px; justify-items: center; max-width: 420px; }
.dot.big { width: 14px; height: 14px; }

.recent-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.recent-row .name { font-weight: 600; }
.recent-row .when { margin-left: auto; }
.badge.outcome { text-transform: none; letter-spacing: 0; }
.badge.outcome.completed { color: var(--live); border-color: rgba(47,212,122,.4); }
.badge.outcome.expired, .badge.outcome.left, .badge.outcome.declined { color: var(--muted); }
.badge.outcome.waiting, .badge.outcome.invited, .badge.outcome.connecting, .badge.outcome.in_call { color: var(--busy); border-color: rgba(255,176,32,.4); }

/* ── Embed tab ────────────────────────────────────────────────────────────── */
.embed-grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(0, 1.8fr); gap: 18px; align-items: start; }
@media (max-width: 960px) { .embed-grid { grid-template-columns: 1fr; } }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } }

.site-card.disabled { opacity: .6; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 999px;
  padding: 4px 6px 4px 11px; font-size: 13px;
}
.chip .sub { color: var(--muted); font-size: 11px; }
.chip button {
  width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 0;
  background: var(--surface-2); color: var(--muted); font-size: 13px; line-height: 1;
}
.chip button:hover { color: var(--danger); }
.domain-form { display: flex; gap: 8px; }
.domain-form input { flex: 1; }
.domain-form button { flex: none; }
.site-error { color: var(--danger); font-size: 13px; }
.switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); cursor: pointer; }
.switch input { width: auto; }

/* ── Inbox ────────────────────────────────────────────────────────────────── */
.inbox-row { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--bg); display: grid; gap: 8px; }
.inbox-row .who { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.inbox-row .name { font-weight: 600; }
.inbox-row .question {
  background: var(--surface); border: 1px solid var(--border); border-radius: 9px;
  padding: 9px 11px; font-size: 14px; color: #dbe1ea; overflow-wrap: anywhere; white-space: pre-line;
}

/* ── Clip tab ─────────────────────────────────────────────────────────────── */
.clip-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, 1fr); gap: 18px; align-items: start; }
@media (max-width: 900px) { .clip-grid { grid-template-columns: 1fr; } }
.tips { margin: 0; padding-left: 18px; display: grid; gap: 8px; }

.metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; }
@media (max-width: 620px) { .metrics { grid-template-columns: repeat(2, minmax(0,1fr)); } }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.metric .value { font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
.metric .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .07em; }

.queue-item {
  border: 1px solid var(--border); border-radius: 12px; padding: 14px;
  background: var(--surface); display: grid; gap: 8px;
}
.queue-item.next { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.queue-item.invited { border-color: var(--busy); box-shadow: 0 0 0 1px var(--busy) inset; }
.queue-item .who { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.queue-item .name { font-weight: 600; font-size: 16px; }
.queue-item .question {
  background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
  padding: 9px 11px; font-size: 13px; color: #dbe1ea;
  /* Visitor text. Rendered as text content by the client, never as HTML. */
  overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.queue-item .between { flex-wrap: wrap; }
.badge {
  font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600;
  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted);
}
.badge.site { color: #cdd5e0; }
/* Durations are lowercase units ("4m 12s"); the uppercase treatment that suits a
   site name turns them into shouting. */
.badge.wait { text-transform: none; letter-spacing: 0; }
.badge.invited { color: var(--busy); border-color: rgba(255,176,32,.4); }
.badge.away { color: var(--danger); border-color: rgba(255,90,82,.4); }

.call-stage { position: relative; background: #000; border-radius: var(--radius); overflow: hidden; height: clamp(460px, 72vh, 820px); }
.call-stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }

.empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 14px; }

.banner {
  margin-bottom: 14px; padding: 11px 14px; border-radius: 10px; font-size: 14px;
  background: rgba(255,176,32,.12); border: 1px solid rgba(255,176,32,.45); color: #ffd27a;
  animation: banner-in .18s ease-out;
}
@keyframes banner-in { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }
.btn-ghost.muted-toggle { color: var(--muted); }
.toast-wrap { position: fixed; left: 50%; transform: translateX(-50%); bottom: 22px; display: grid; gap: 8px; z-index: 50; }
.toast {
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
  border-radius: 10px; padding: 10px 14px; box-shadow: var(--shadow); font-size: 14px;
}
.toast.error { border-color: rgba(255,90,82,.5); }

.embed-snippet {
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; overflow-x: auto; white-space: pre; margin: 0;
}


/* ── Camera surface ─────────────────────────────────────────────────────────
 * Shared by the device check and the intro-clip recorder. A modal rather than an
 * inline panel because a self-view has to be big enough to actually judge your
 * framing and your light by. */

.modal {
  position: fixed; inset: 0; z-index: 100;
  display: grid; place-items: center; padding: 20px;
  background: rgba(6,7,9,.72); backdrop-filter: blur(6px);
}
.modal-card {
  width: min(94vw, 560px); max-height: 92vh; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px; display: grid; gap: 12px;
  box-shadow: var(--shadow);
}

.media-stage {
  position: relative; background: #000; border-radius: 12px; overflow: hidden;
  aspect-ratio: 16 / 10; border: 1px solid var(--border);
}
.media-stage video {
  width: 100%; height: 100%; object-fit: cover; display: block;
  /* Your own camera is a mirror. Anything else is disorienting to sit in front of. */
  transform: scaleX(-1);
}
/* The recorded clip is NOT mirrored: it is played back to visitors, who should
   see you the way a camera does, not the way a mirror does. */
.media-stage video#media-playback { transform: none; }

.media-timer {
  position: absolute; top: 10px; left: 10px;
  display: flex; align-items: center; gap: 6px;
  background: rgba(8,10,13,.72); border: 1px solid var(--border);
  border-radius: 999px; padding: 4px 11px;
  font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 600;
}
.media-timer.over { color: var(--busy); border-color: rgba(255,176,32,.5); }

.media-sound {
  position: absolute; right: 10px; bottom: 10px;
  background: rgba(8,10,13,.72); border: 1px solid var(--border);
  border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600;
}
.media-sound.off { color: var(--muted); }

/* The saved clip, as it appears in the Intro clip panel. */
.clip-preview { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
.clip-preview video { width: 100%; display: block; background: #000; }

/* Approving a recording swaps this panel's contents while the modal is closing,
   several hundred pixels from where the eye was. The flash is what makes the
   change land as "that worked" rather than "did anything happen?". */
@keyframes clip-landed {
  0%   { box-shadow: 0 0 0 0 rgba(91,140,255,.0); }
  20%  { box-shadow: 0 0 0 3px rgba(91,140,255,.65); }
  100% { box-shadow: 0 0 0 0 rgba(91,140,255,0); }
}
.clip-preview.landed { animation: clip-landed 1.6s ease-out; }
.modal.recording .media-stage { box-shadow: 0 0 0 2px var(--danger) inset; }

/* Mic level. The single fastest way to answer "can you hear me" before a call
   rather than during one. */
.level { height: 5px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.level > i { display: block; height: 100%; width: 0%; background: var(--live); transition: width .08s linear; }
.level.quiet > i { background: var(--muted); }

.device-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 520px) { .device-grid { grid-template-columns: 1fr; } }

.error-box {
  border: 1px solid rgba(255,90,82,.45); background: rgba(255,90,82,.08);
  border-radius: 10px; padding: 11px; font-size: 14px;
}
`

export const CALL_STYLES = `
body { background: #000; overflow: hidden; }
.call { position: fixed; inset: 0; display: grid; grid-template-rows: 1fr auto; }

.stage { position: relative; background: #000; overflow: hidden; }
.remote { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
.local {
  position: absolute; right: 12px; bottom: 12px; width: 26%; max-width: 190px; min-width: 104px;
  aspect-ratio: 3 / 4; object-fit: cover; border-radius: 12px; border: 1px solid rgba(255,255,255,.16);
  background: #111; box-shadow: var(--shadow); z-index: 2;
  /* Your own preview is a mirror; anything else is disorienting to look at. */
  transform: scaleX(-1);
}
.local.setup { position: static; width: 100%; max-width: none; aspect-ratio: 16 / 9; border-radius: 12px; }

/* Screen share. The share takes the stage; the sharer's camera becomes a tile
   in the top-right so their face stays on screen while they point at things. */
.share { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
.stage.sharing .remote {
  position: absolute; top: calc(12px + env(safe-area-inset-top)); right: 12px; left: auto; bottom: auto;
  width: 22%; max-width: 200px; min-width: 96px; height: auto; aspect-ratio: 4 / 3;
  border-radius: 12px; border: 1px solid rgba(255,255,255,.16); box-shadow: var(--shadow); z-index: 2;
}
.share-pill {
  position: absolute; top: calc(12px + env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); z-index: 4;
  background: rgba(47,212,122,.16); color: var(--live); border: 1px solid rgba(47,212,122,.45);
  border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.ctrl.on { background: var(--live); border-color: var(--live); color: #06240f; }
.hear {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 6;
  background: var(--accent); border-color: var(--accent); color: var(--accent-ink);
  font-weight: 600; border-radius: 999px; padding: 10px 18px; box-shadow: var(--shadow);
}

.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; text-align: center;
  padding: 24px; background: radial-gradient(60% 60% at 50% 40%, #16181d 0%, #0a0b0d 100%); z-index: 3;
  /* Taller than the stage? Scroll from the top rather than centring and cutting
     the top of the preview off. margin:auto on .inner centres it when it fits. */
  overflow: auto;
}
.overlay .inner { max-width: 420px; width: 100%; display: grid; gap: 14px; justify-items: center; margin: auto; }
.overlay .actions { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 10px; }
/* The camera check: the preview is the point, so it gets the room. */
.overlay.setup .inner { max-width: 620px; }
@media (min-width: 680px) {
  .overlay.setup .inner {
    max-width: 960px; gap: 10px 20px; text-align: left; justify-items: stretch; align-items: start;
    grid-template-columns: minmax(0, 3fr) minmax(230px, 2fr);
    grid-template-areas: "preview title" "preview body" "preview devices" "preview error" "preview actions" "preview .";
    grid-template-rows: auto auto auto auto auto 1fr;
  }
  .overlay.setup #overlay-title { grid-area: title; margin: 0; }
  .overlay.setup #overlay-body { grid-area: body; }
  .overlay.setup #preview { grid-area: preview; align-self: center; }
  .overlay.setup #device-row { grid-area: devices; }
  .overlay.setup #overlay-error { grid-area: error; }
  .overlay.setup .actions { grid-area: actions; justify-content: flex-start; }
}
.avatar-lg { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; background: var(--surface-2); }

.controls {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
  background: #0d0e11; border-top: 1px solid var(--border);
}
.ctrl {
  width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center;
  background: var(--surface-2); border: 1px solid var(--border); padding: 0;
}
.ctrl.off { background: var(--danger); border-color: var(--danger); color: #2a0503; }
.ctrl.end { width: auto; border-radius: 999px; padding: 0 20px; background: var(--danger); border-color: var(--danger); color: #2a0503; font-weight: 600; }
.ctrl svg { width: 20px; height: 20px; }

.timer {
  position: absolute; top: calc(12px + env(safe-area-inset-top)); left: 12px; z-index: 4;
  display: flex; align-items: center; gap: 7px;
  background: rgba(10,11,13,.72); backdrop-filter: blur(8px);
  border: 1px solid var(--border); border-radius: 999px; padding: 5px 11px; font-size: 13px;
}
.peer-name {
  position: absolute; bottom: 12px; left: 12px; z-index: 2;
  background: rgba(10,11,13,.68); backdrop-filter: blur(8px);
  border-radius: 8px; padding: 4px 9px; font-size: 13px;
}

.device-row { display: grid; gap: 8px; width: 100%; text-align: left; }

/* Level meters: a bar that moves with sound. Green for you, blue for them. */
.level-row { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 10px; margin-top: 6px; }
.level { height: 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; }
.level i { display: block; height: 100%; width: 0; background: var(--live); border-radius: inherit; transition: width 80ms linear; }
.level.remote i { background: var(--accent); }

/* In-call settings panel, docked above the controls. */
.settings {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 7;
  width: min(380px, calc(100% - 24px)); display: grid; gap: 12px; text-align: left;
  background: rgba(13,14,17,.96); backdrop-filter: blur(10px);
  border: 1px solid var(--border); border-radius: 14px; padding: 14px; box-shadow: var(--shadow);
}
.settings select { width: 100%; }
.error-box {
  border: 1px solid rgba(255,90,82,.45); background: rgba(255,90,82,.08);
  border-radius: 10px; padding: 12px; font-size: 14px; text-align: left;
}
`

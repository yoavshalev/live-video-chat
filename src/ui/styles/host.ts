/** The agent dashboard: tabs, the live grid, sites, inbox, the camera modal. */

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

/**
 * Base styles shared by the two first-party pages — the dashboard and the call
 * surface. Tokens, buttons, inputs, the status dot.
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

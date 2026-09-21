/** The call surface: stage, controls, the pre-call check, the settings panel. */

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
  min-width: 58px; height: 56px; border-radius: 14px; display: grid; place-items: center; gap: 3px;
  grid-template-rows: auto auto; background: var(--surface-2); border: 1px solid var(--border); padding: 0 8px;
}
.ctrl-label { font-size: 10px; line-height: 1; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.ctrl.off { background: var(--danger); border-color: var(--danger); color: #2a0503; }
.ctrl.off .ctrl-label { color: #2a0503; font-weight: 700; }
.ctrl.end { grid-template-rows: auto; border-radius: 999px; padding: 0 20px; background: var(--danger); border-color: var(--danger); color: #2a0503; font-weight: 600; }
.ctrl svg { width: 20px; height: 20px; }

/* The other person's microphone is off: what to tell them, right under their name. */
.peer-hint {
  position: absolute; bottom: 46px; left: 12px; z-index: 2; max-width: min(420px, calc(100% - 24px));
  background: rgba(255,90,82,.16); backdrop-filter: blur(8px); color: #fff;
  border: 1px solid rgba(255,90,82,.55); border-radius: 10px; padding: 8px 12px; font-size: 13px; line-height: 1.4;
}

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
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.check input { margin: 0; }

/* "Your microphone is off" — under the timer, above everything else. */
.mic-off {
  position: absolute; top: calc(52px + env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); z-index: 8;
  display: flex; align-items: center; gap: 10px; max-width: calc(100% - 24px);
  background: rgba(255,90,82,.16); backdrop-filter: blur(8px); color: #fff;
  border: 1px solid rgba(255,90,82,.55); border-radius: 999px; padding: 6px 8px 6px 14px; font-size: 13px;
}
.mic-off .btn-primary { padding: 6px 12px; border-radius: 999px; font-size: 13px; }
/* On a phone the banner is the most important thing on the screen: full
   width, big words, a button a thumb cannot miss. */
@media (max-width: 520px) {
  .mic-off {
    left: 12px; right: 12px; transform: none; max-width: none; border-radius: 14px;
    flex-direction: column; align-items: stretch; text-align: center; padding: 12px 14px; font-size: 15px; line-height: 1.35;
  }
  .mic-off .btn-primary { padding: 12px 18px; font-size: 16px; }
}
.error-box {
  border: 1px solid rgba(255,90,82,.45); background: rgba(255,90,82,.08);
  border-radius: 10px; padding: 12px; font-size: 14px; text-align: left;
}
`

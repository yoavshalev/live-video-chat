/** The camera surface: the audio & video settings check and the in-browser recorder. */

import { html } from 'hono/html'
import type { Html } from '../layout'

export function mediaModal(): Html {
  return html`<div id="media-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="media-title">
    <div class="modal-card">
      <div class="between">
        <h2 id="media-title">Audio and video settings</h2>
        <button id="media-close" class="btn-ghost" type="button">Close</button>
      </div>
      <p id="media-hint" class="small muted" style="margin:0"></p>
      <div class="media-stage">
        <video id="media-preview" autoplay playsinline muted></video>
        <video id="media-playback" class="hidden" playsinline loop></video>
        <span id="media-timer" class="media-timer hidden">0.0s</span>
        <button id="media-sound" class="media-sound hidden" type="button" aria-pressed="true">Sound on</button>
      </div>
      <div>
        <label style="margin-bottom:5px">Microphone level</label>
        <div id="media-level" class="level"><i id="media-level-bar"></i></div>
      </div>
      <div class="device-grid">
        <div><label for="media-camera">Camera</label><select id="media-camera"></select></div>
        <div><label for="media-mic">Microphone</label><select id="media-mic"></select></div>
        <!-- Output. Hidden where the browser cannot direct sound at a
             device (Safari); "Test" rings the chosen one so a headset
             left on the desk is found before a call, not during it. -->
        <div id="media-speaker-wrap" class="hidden" style="grid-column: 1 / -1">
          <label for="media-speaker">Speaker</label>
          <div class="row">
            <select id="media-speaker" style="flex:1;min-width:0"></select>
            <button id="media-speaker-test" class="btn-ghost" type="button">Test</button>
          </div>
        </div>
      </div>
      <div id="media-error" class="error-box hidden" role="alert"></div>
      <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
        <button id="media-record" class="btn-danger hidden" type="button">Start recording</button>
        <button id="media-stop" class="btn-ghost hidden" type="button">Stop</button>
        <button id="media-retake" class="btn-ghost hidden" type="button">Retake</button>
        <button id="media-use" class="btn-primary hidden" type="button">Use this clip</button>
      </div>
    </div>
  </div>`
}

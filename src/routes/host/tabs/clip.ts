/** The Clip tab: the organization's intro loop — record, upload, preview. */

import { html } from 'hono/html'
import type { HostProfileView } from '../../../shared/protocol'
import type { Html } from '../layout'

export function clipTab(profile: HostProfileView | null): Html {
  return html`<section id="tab-clip" class="tab-panel hidden" role="tabpanel">
    <div class="clip-grid">
      <section class="card stack" aria-label="Intro clip">
        <h2>Intro clip</h2>
        <p class="small muted" style="margin:0">
          A 5–15s loop, shown while anyone is live and labelled as an intro, never as a live feed.
          Visitors see it muted with an unmute button — browsers refuse to autoplay sound — so lead
          with a face, not a sentence that needs audio. One clip for the whole organization.
        </p>
        <div id="loop-wrap" class="clip-preview${profile?.loopVideoUrl ? '' : ' hidden'}">
          <video id="loop-preview" ${profile?.loopVideoUrl ? html`src="${profile.loopVideoUrl}"` : ''} muted playsinline autoplay></video>
          <button id="loop-sound" class="media-sound off" type="button" aria-pressed="false">Sound off</button>
        </div>
        ${profile?.loopVideoUrl ? '' : html`<p id="loop-empty" class="small muted" style="margin:0">No clip yet. The widget shows a designed fallback until someone records one.</p>`}
        <button id="btn-record" class="btn-primary" type="button">Record a new clip</button>
        <details>
          <summary class="tiny muted" style="cursor:pointer">Or upload a file</summary>
          <form id="loop-form" enctype="multipart/form-data" class="stack" style="margin-top:10px">
            <input id="loop-file" type="file" name="file" accept="video/mp4,video/webm" />
            <button class="btn-ghost" type="submit">Upload clip</button>
          </form>
        </details>
        <p id="loop-status" class="tiny muted" style="margin:0"></p>
      </section>

      <section class="card stack" aria-label="Tips">
        <h2>What works</h2>
        <ul class="small muted tips">
          <li>Look at the lens, not the screen. Five seconds of eye contact does the job.</li>
          <li>Record in the light you'll actually be in when you go live.</li>
          <li>Re-record often. A clip that says "here's what we're working on today" is the whole point.</li>
          <li>MP4 plays everywhere. If the recorder says it made WebM, iPhones show the still frame instead — Safari records MP4 natively.</li>
        </ul>
      </section>
    </div>
  </section>`
}

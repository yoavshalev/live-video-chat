/** Someone is live: the intro clip, the headline, the button that starts the funnel. */

import type { Widget } from '../widget'
import { COPY, withName } from '../../../src/config'
import { el, replace } from '../dom'
import { renderAvatar } from './bubble'
import { renderOfflineForm } from './offline'

export function renderLive(w: Widget, body: HTMLElement): void {
  const status = w.statusOf()
  if (status === 'offline') {
    renderOfflineForm(w, body)
    return
  }

  const waiting = w.presence?.queueLength ?? 0
  const busy = status === 'busy'
  const paused = status === 'paused'

  const headline = withName(busy ? COPY.busyHeadline : COPY.liveHeadline, w.name())
  const text = paused ? withName(COPY.pausedBody, w.name()) : busy ? COPY.busyBody : COPY.liveBody

  const cta = el('button', {
    class: 'btn primary',
    attrs: { type: 'button', disabled: paused },
    text: withName(busy ? COPY.busyCta : COPY.liveCta, w.name()),
    on: {
      click: () => {
        w.track('talk_clicked')
        w.emit('talkclicked')
        w.setView('form')
        w.track('join_form_started')
      }
    }
  })

  replace(
    body,
    w.clip.render(w.profile, w.name(), () => renderAvatar(w)),
    el('h2', { class: 'title', text: headline }),
    el('p', { class: 'text', text: w.config?.site.customGreeting ?? text }),
    busy && waiting > 0
      ? el('p', { class: 'text', children: [el('strong', { text: `${waiting} ${waiting === 1 ? 'person' : 'people'}` }), ' waiting.'] })
      : null,
    cta,
    el('p', { class: 'clip-note', text: COPY.clipNote })
  )
}

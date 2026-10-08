/** The collapsed state: one button in the corner that says who is live. */

import type { Widget } from '../widget'
import { COPY, withName } from '../../../src/config'
import { ICONS, el, icon } from '../dom'

export function renderBubble(w: Widget): HTMLElement {
  const status = w.statusOf()
  const waiting = w.presence?.queueLength ?? 0

  let label: string
  if (status === 'offline') label = withName(COPY.offlineHeadline, w.name())
  else if (status === 'busy' || status === 'paused') label = `${w.name()} is live`
  else label = withName(COPY.liveCta, w.name())

  return el('button', {
    class: status === 'offline' ? 'bubble' : 'bubble has-video',
    attrs: {
      type: 'button',
      'aria-label': status === 'offline' ? `${w.name()} is offline — leave a question` : `${label} — video call`,
      'aria-haspopup': 'dialog'
    },
    on: { click: () => w.open() },
    children: [
      renderAvatar(w),
      el('span', { class: `dot ${status}`, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'label', text: label }),
      status === 'busy' && waiting > 0
        ? el('span', { class: 'count', text: `· ${waiting} waiting` })
        : null,
      // The camera at the end is what says "video" at a glance: a call button
      // on the pill. Not when offline — that bubble leads to a message form.
      status === 'offline'
        ? null
        : el('span', { class: 'video-cta', attrs: { 'aria-hidden': 'true' }, children: [icon(ICONS.video, 13)] })
    ]
  })
}

export function renderAvatar(w: Widget): HTMLElement {
  const url = w.profile?.avatarUrl
  if (url) {
    return el('img', {
      class: 'avatar',
      attrs: { src: url, alt: '', width: 26, height: 26, loading: 'lazy', decoding: 'async' }
    })
  }
  return el('span', {
    class: 'avatar',
    attrs: { 'aria-hidden': 'true' },
    text: w.name().slice(0, 1).toUpperCase()
  })
}

/** The open panel: its chrome (sheet grab, close) and whichever screen is current. */

import type { Widget } from '../widget'
import { ICONS, el, icon } from '../dom'
import { renderLive } from './live'
import { renderForm } from './form'
import { renderWaiting } from './waiting'
import { renderInvited } from './invited'
import { renderCall, renderEnded } from './call'
import { renderOfflineForm, renderOfflineSent } from './offline'

export function renderPanel(w: Widget): HTMLElement {
  const body = el('div', { class: 'body' })

  const panel = el('div', {
    class: 'panel',
    attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': `Talk to ${w.name()}` },
    children: [
      // Shown only on phones (see .sheet-grab in styles). A thumb-sized target
      // at the top of the sheet, where a chevron is understood to mean "put
      // this away" — and during a call, to end it.
      el('button', {
        class: 'sheet-grab',
        attrs: {
          type: 'button',
          'aria-label': w.view === 'call' ? 'End call' : 'Close'
        },
        on: { click: () => w.dismiss() },
        children: [icon(ICONS.chevronDown, 24)]
      }),
      el('div', {
        class: 'panel-head',
        children: [
          el('span', { class: 'sr-only', text: `Talk to ${w.name()}` }),
          el('button', {
            class: 'close',
            attrs: { type: 'button', 'aria-label': 'Close' },
            on: { click: () => w.close() },
            children: [icon(ICONS.close, 16)]
          })
        ]
      }),
      body
    ]
  })

  switch (w.view) {
    case 'live':
      renderLive(w, body)
      break
    case 'form':
      renderForm(w, body)
      break
    case 'waiting':
      renderWaiting(w, body)
      break
    case 'invited':
      renderInvited(w, body)
      break
    case 'call':
      renderCall(w, body, panel)
      break
    case 'ended':
      renderEnded(w, body)
      break
    case 'offline_form':
      renderOfflineForm(w, body)
      break
    case 'offline_sent':
      renderOfflineSent(w, body)
      break
    default:
      break
  }

  // Escape closes, except during a call. Focus moves to the panel so keyboard
  // users are actually inside the thing that just opened.
  panel.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') w.close()
  })
  // Precedence matters: a single querySelector with a list returns whatever
  // comes first in the DOM, which is the close button. Focus belongs on the
  // thing the visitor came to do.
  queueMicrotask(() => {
    const target =
      panel.querySelector<HTMLElement>('input, textarea') ??
      panel.querySelector<HTMLElement>('.btn.primary') ??
      panel.querySelector<HTMLElement>('.btn')
    target?.focus({ preventScroll: true })
  })

  return panel
}

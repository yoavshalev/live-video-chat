/** In line: the position, an honest estimate, and a way out. */

import type { Widget } from '../widget'
import { bucketWait } from '../../../src/config'
import { clientMsg } from '../../../src/shared/protocol'
import { commandId } from '../../shared/socket'
import { el, replace } from '../dom'

export function renderWaiting(w: Widget, body: HTMLElement): void {
  const position = w.position
  const ahead = position?.peopleAhead ?? 0
  const estimate = position?.estimatedWaitSeconds ?? null

  replace(
    body,
    el('h2', { class: 'title', text: "You're in line" }),
    el('div', {
      class: 'position',
      children: [
        el('span', { class: 'n', text: `#${position?.position ?? 1}` }),
        el('span', {
          class: 'eta',
          text: ahead === 0 ? "You're next" : `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you`
        })
      ]
    }),
    // No estimate until there is enough history to make an honest one. A number
    // invented from two data points is worse than no number.
    estimate !== null
      ? el('p', { class: 'text', text: `Approximate wait: ${bucketWait(estimate)}` })
      : null,
    el('p', { class: 'hint', text: `Keep this tab open — I'll let you know when ${w.name()} is ready.` }),
    el('button', {
      class: 'btn quiet',
      attrs: { type: 'button' },
      text: 'Leave the line',
      on: {
        click: () => {
          w.send(clientMsg('QUEUE_LEAVE', { commandId: commandId() }))
          w.position = null
          w.setView('live')
          w.emit('queueleft', {})
        }
      }
    })
  )
}

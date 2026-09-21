/** Your turn: the agent's name, a countdown, join or not now. */

import type { Widget } from '../widget'
import { COPY, withName } from '../../../src/config'
import { clientMsg } from '../../../src/shared/protocol'
import { commandId } from '../../shared/socket'
import { el, replace } from '../dom'

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.max(0, seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function renderInvited(w: Widget, body: HTMLElement): void {
  const total = Math.max(1, Math.round(((w.inviteExpiresAt ?? Date.now()) - Date.now()) / 1000))
  const countdown = el('span', { class: 'countdown', text: formatClock(total) })
  const bar = el('i')

  replace(
    body,
    el('div', {
      class: 'ready',
      children: [
        el('div', {
          class: 'row',
          children: [
            el('span', { class: 'dot available', attrs: { 'aria-hidden': 'true' } }),
            el('h2', { class: 'title', text: withName(COPY.invitedTitle, w.inviteAgentName ?? w.name()) })
          ]
        }),
        el('p', { class: 'text', text: COPY.invitedBody }),
        el('div', { class: 'ring', children: [bar] }),
        countdown
      ]
    }),
    el('button', {
      class: 'btn primary',
      attrs: { type: 'button' },
      text: 'Join video call',
      on: {
        click: () => {
          w.send(clientMsg('VISITOR_ACCEPT_INVITE', { commandId: commandId() }))
          w.attention.stopTitleFlash()
        }
      }
    }),
    el('button', {
      class: 'btn quiet',
      attrs: { type: 'button' },
      text: 'Not now',
      on: {
        click: () => {
          w.send(clientMsg('VISITOR_DECLINE_INVITE', { commandId: commandId() }))
          w.setView('live')
        }
      }
    })
  )

  w.startCountdown(countdown, bar, total)
}

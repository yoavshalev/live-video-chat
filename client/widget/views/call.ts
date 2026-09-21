/**
 * The call runs in a same-origin iframe.
 *
 * That single decision is what lets the conversation happen without the visitor
 * leaving the page, while keeping the WebRTC SDK, the media permissions and all
 * of the call's CSS inside our own origin rather than injected into a customer's
 * site. `allow` is what grants the frame camera and microphone; without it the
 * browser refuses regardless of what the visitor clicks.
 */

import type { Widget } from '../widget'
import { el, replace } from '../dom'

export function renderCall(w: Widget, body: HTMLElement, panel: HTMLElement): void {
  const call = w.call
  if (!call) {
    w.setView('live')
    return
  }

  const url = new URL(`${w.config?.callUrl ?? `${w.baseUrl}/call`}`)
  url.searchParams.set('callId', call.callId)
  url.searchParams.set('secret', call.secret)
  url.searchParams.set('who', 'visitor')
  url.searchParams.set('visitorId', w.visitorId)
  url.searchParams.set('name', w.inviteAgentName ?? w.name())
  // Lets the call page set frame-ancestors and its postMessage target to this
  // exact origin instead of a wildcard — validated server-side against the
  // site's allow-list, so claiming someone else's origin achieves nothing.
  url.searchParams.set('siteId', w.options.siteId)
  url.searchParams.set('origin', location.origin)

  const frame = el('iframe', {
    class: 'call-frame',
    attrs: {
      src: url.toString(),
      allow: 'camera; microphone; autoplay; fullscreen; speaker-selection',
      title: `Video call with ${w.name()}`
    }
  })

  replace(body, frame)
  // Hidden during a healthy call so a stray click cannot hang up on someone —
  // but restored the moment the call surface says it failed, or there is no
  // way out of the error screen.
  panel.querySelector('.panel-head')?.classList.toggle('hidden', !w.callErrored)

  if (w.iframeFallback) {
    // Rendered outside the frame, because if the frame cannot get permissions
    // it cannot show the way out of that either.
    body.append(
      el('div', {
        class: 'form',
        attrs: { style: 'padding:14px' },
        children: [
          el('p', { class: 'text', text: 'Your browser blocked the camera inside this page.' }),
          el('a', {
            class: 'btn primary',
            attrs: { href: url.toString(), target: '_blank', rel: 'noopener' },
            text: 'Open the call in a new tab'
          })
        ]
      })
    )
  }
}

export function renderEnded(w: Widget, body: HTMLElement): void {
  w.iframeFallback = false
  w.callErrored = false
  replace(
    body,
    el('h2', { class: 'title', text: `Thanks for talking to ${w.name()}` }),
    el('p', { class: 'text', text: 'Thanks for the conversation.' }),
    el('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Close', on: { click: () => w.close() } })
  )
}

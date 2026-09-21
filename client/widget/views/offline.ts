/** Nobody is live: a message form, and the thank-you after it. */

import type { Widget } from '../widget'
import { COPY, withName } from '../../../src/config'
import { el, replace } from '../dom'

export function renderOfflineForm(w: Widget, body: HTMLElement): void {
  const name = el('input', {
    attrs: { id: 'fl-off-name', type: 'text', required: true, maxlength: 40, autocomplete: 'given-name', placeholder: 'Your name' }
  }) as HTMLInputElement
  const email = el('input', {
    attrs: { id: 'fl-off-email', type: 'email', maxlength: 120, autocomplete: 'email', placeholder: 'you@company.com' }
  }) as HTMLInputElement
  const message = el('textarea', {
    attrs: { id: 'fl-off-message', required: true, maxlength: 2000, placeholder: 'What would you like to ask?' }
  }) as HTMLTextAreaElement

  const form = el('form', {
    class: 'form',
    attrs: { novalidate: true },
    on: {
      submit: async (event) => {
        event.preventDefault()
        if (!name.value.trim() || !message.value.trim()) {
          w.formError = 'Add your name and a message.'
          w.render()
          return
        }
        w.busy = true
        w.render()
        try {
          const response = await fetch(
            `${w.baseUrl}/api/offline-message?siteId=${encodeURIComponent(w.options.siteId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'omit',
              body: JSON.stringify({
                visitorId: w.visitorId,
                name: name.value.trim(),
                email: email.value.trim() || null,
                message: message.value.trim(),
                pageUrl: location.href
              })
            }
          )
          if (!response.ok) throw new Error(String(response.status))
          w.setView('offline_sent')
          w.emit('offlinemessagesent', {})
        } catch {
          w.busy = false
          w.formError = 'That did not send. Try again in a moment.'
          w.render()
        }
      }
    },
    children: [
      el('h2', { class: 'title', text: withName(COPY.offlineHeadline, w.name()) }),
      el('p', { class: 'text', text: withName(COPY.offlineBody, w.name()) }),
      el('div', { children: [el('label', { attrs: { for: 'fl-off-name' }, text: 'Your name *' }), name] }),
      el('div', { children: [el('label', { attrs: { for: 'fl-off-email' }, text: 'Email' }), email] }),
      el('div', { children: [el('label', { attrs: { for: 'fl-off-message' }, text: 'Message *' }), message] }),
      w.formError ? el('p', { class: 'field-error', attrs: { role: 'alert' }, text: w.formError }) : null,
      el('button', {
        class: 'btn primary',
        attrs: { type: 'submit', disabled: w.busy },
        text: w.busy ? 'Sending…' : 'Send'
      })
    ]
  })

  replace(body, form)
}

export function renderOfflineSent(w: Widget, body: HTMLElement): void {
  replace(
    body,
    el('h2', { class: 'title', text: 'Got it.' }),
    el('p', { class: 'text', text: `${w.name()} will come back to you.` }),
    el('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Close', on: { click: () => w.close() } })
  )
}

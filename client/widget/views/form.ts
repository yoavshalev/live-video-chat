/** The join form: a name, an optional email, what they want to talk about. */

import type { Widget } from '../widget'
import { COPY, withName } from '../../../src/config'
import { clientMsg } from '../../../src/shared/protocol'
import { commandId } from '../../shared/socket'
import { el, replace } from '../dom'

export function renderForm(w: Widget, body: HTMLElement): void {
  const name = el('input', {
    attrs: { id: 'fl-name', type: 'text', required: true, maxlength: 40, autocomplete: 'given-name', placeholder: 'Sarah' },
    on: { input: (event) => { w.draft.firstName = (event.target as HTMLInputElement).value } }
  })
  const email = el('input', {
    attrs: { id: 'fl-email', type: 'email', maxlength: 120, autocomplete: 'email', placeholder: 'you@company.com' },
    on: { input: (event) => { w.draft.email = (event.target as HTMLInputElement).value } }
  })
  const question = el('textarea', {
    attrs: { id: 'fl-question', maxlength: 500, placeholder: 'What do you want to talk about?' },
    on: { input: (event) => { w.draft.question = (event.target as HTMLTextAreaElement).value } }
  })
  name.value = w.draft.firstName
  email.value = w.draft.email
  question.value = w.draft.question

  const submit = el('button', {
    class: 'btn primary',
    attrs: { type: 'submit', disabled: w.busy },
    text: w.busy ? 'Joining…' : 'Join the line'
  })

  const form = el('form', {
    class: 'form',
    attrs: { novalidate: true },
    on: {
      submit: (event) => {
        event.preventDefault()
        const firstName = name.value.trim()
        if (!firstName) {
          w.formError = 'Please add your first name.'
          w.render()
          return
        }
        w.busy = true
        const sent = w.send(
          clientMsg('QUEUE_JOIN', {
            commandId: commandId(),
            firstName,
            email: email.value.trim() || undefined,
            question: question.value.trim() || undefined,
            pageUrl: location.href,
            pageTitle: document.title.slice(0, 200),
            referrer: document.referrer || undefined
          })
        )
        if (!sent) {
          w.busy = false
          w.formError = 'Connection lost — try again in a moment.'
          w.render()
          return
        }
        // A socket can report OPEN and still be a black hole (a suspended tab,
        // a proxy that dropped the connection silently). Without this the
        // button has no way back and the visitor just leaves.
        w.startJoinTimeout()
        w.render()
        w.emit('queuejoined', {})
      }
    },
    children: [
      el('h2', { class: 'title', text: withName(COPY.joinTitle, w.name()) }),
      el('div', { children: [el('label', { attrs: { for: 'fl-name' }, text: 'Your name *' }), name] }),
      el('div', { children: [el('label', { attrs: { for: 'fl-email' }, text: 'Email (optional)' }), email] }),
      el('div', {
        children: [el('label', { attrs: { for: 'fl-question' }, text: 'What do you want to talk about?' }), question]
      }),
      w.formError ? el('p', { class: 'field-error', attrs: { role: 'alert' }, text: w.formError }) : null,
      submit,
      el('p', { class: 'consent', text: withName(COPY.joinConsent, w.name()) }),
      el('button', {
        class: 'btn quiet',
        attrs: { type: 'button' },
        text: 'Back',
        on: { click: () => w.setView('live') }
      })
    ]
  })

  replace(body, form)
}

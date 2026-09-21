/** The Inbox tab: every join request and offline message, newest first. */

import type { InboxItem } from './boot'
import { describe, els, shortenUrl, text } from './dom'

export async function refreshInbox(): Promise<void> {
  try {
    const response = await fetch('/api/host/inbox')
    if (!response.ok) throw new Error(`inbox ${response.status}`)
    const { items } = (await response.json()) as { items: InboxItem[] }
    if (items.length === 0) {
      els.inbox.replaceChildren(text('div', 'empty', 'Nothing yet. Join requests and offline messages will appear here.'))
      return
    }
    els.inbox.replaceChildren(...items.map(renderInboxItem))
  } catch (error) {
    els.inbox.replaceChildren(text('div', 'empty', `Could not load the inbox: ${describe(error)}`))
  }
}

function renderInboxItem(item: InboxItem): HTMLElement {
  const row = document.createElement('div')
  row.className = 'inbox-row'
  const head = document.createElement('div')
  head.className = 'who'
  head.append(
    text('span', 'name', item.name),
    text('span', `badge ${item.kind === 'join' ? 'invited' : ''}`, item.kind === 'join' ? 'Join request' : 'Message'),
    text('span', 'badge site', item.siteId),
    text('span', `badge outcome ${item.status}`, item.status.replace('_', ' ')),
    ...(item.agentName ? [text('span', 'badge', item.agentName)] : []),
    text('span', 'tiny muted', new Date(item.at).toLocaleString())
  )
  row.append(head)
  if (item.body) row.append(text('div', 'question', item.body))
  const meta = document.createElement('div')
  meta.className = 'tiny muted'
  if (item.email) {
    const mail = document.createElement('a')
    mail.href = `mailto:${item.email}`
    mail.textContent = item.email
    meta.append(mail)
  } else meta.append(document.createTextNode('no email'))
  if (item.company) meta.append(document.createTextNode(` · ${item.company}`))
  if (item.pageUrl) {
    meta.append(document.createTextNode(' · '))
    const link = document.createElement('a')
    link.href = item.pageUrl
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = shortenUrl(item.pageUrl)
    meta.append(link)
  }
  row.append(meta)
  return row
}

export function wireInbox(): void {
  els.inboxRefresh.onclick = () => void refreshInbox()
}

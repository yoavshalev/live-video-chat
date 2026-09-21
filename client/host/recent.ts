/**
 * "Earlier today": everyone who joined the line and what happened to them.
 * Rendered by the server on first paint, refreshed here as the day goes on.
 */

import { els, text, timeAgo } from './dom'

export function renderRecentTimes(): void {
  for (const node of els.recent.querySelectorAll<HTMLElement>('.when[data-at]')) node.textContent = timeAgo(Number(node.dataset.at))
}

export async function refreshRecent(): Promise<void> {
  try {
    const response = await fetch('/api/host/recent')
    if (!response.ok) return
    const { sessions } = (await response.json()) as {
      sessions: Array<{ id: string; firstName: string; siteId: string; joinedAt: number; status: string; agentName: string | null }>
    }
    if (sessions.length === 0) {
      els.recent.replaceChildren(text('div', 'empty', 'No one yet today.'))
      return
    }
    els.recent.replaceChildren(
      ...sessions.map((s) => {
        const row = document.createElement('div')
        row.className = 'recent-row'
        const when = text('span', 'tiny muted when', '')
        when.dataset.at = String(s.joinedAt)
        row.append(
          text('span', 'name', s.firstName),
          text('span', 'badge site', s.siteId),
          text('span', `badge outcome ${s.status}`, s.status.replace('_', ' ')),
          ...(s.agentName ? [text('span', 'badge', s.agentName)] : []),
          when
        )
        return row
      })
    )
    renderRecentTimes()
  } catch {
    /* a nicety */
  }
}

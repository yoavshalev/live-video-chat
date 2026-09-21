/**
 * The agent dashboard client.
 *
 * Hydrates the server-rendered skeleton in src/routes/host/ and then owns
 * everything that moves. The server never re-renders this page: a dashboard you
 * have to refresh is a dashboard that is quietly wrong while somebody waits.
 *
 * Modules, one per tab or concern:
 *   socket.ts / messages.ts   the one socket, and what each message changes
 *   live.ts                   status, queue, agents, your own call
 *   attention.ts              chime, title flash, notifications
 *   recent.ts, inbox.ts, sites.ts, team.ts, clip.ts, metrics.ts
 *   state.ts                  what the page knows; dom.ts — how it draws
 */

import { boot } from './boot'
import { toast } from './dom'
import { live } from './state'
import { connectSocket, nudgeSocket } from './socket'
import { handleMessage } from './messages'
import { renderQueue, setConnected, wireLiveControls } from './live'
import { wireAttention } from './attention'
import { renderRecentTimes } from './recent'
import { wireInbox } from './inbox'
import { renderSites, wireSiteForm } from './sites'
import { renderTeam, wireTeamForms } from './team'
import { wireClip } from './clip'
import { refreshMetrics } from './metrics'
import { wireTabs } from './tabs'

wireTabs()
wireLiveControls()
wireAttention()
wireInbox()
wireSiteForm()
wireTeamForms()
wireClip()

renderSites()
renderTeam()
renderRecentTimes()
connectSocket({ onMessage: handleMessage, onStatus: setConnected })
void refreshMetrics()

// Waits and "x minutes ago" tick along without a server message.
setInterval(() => {
  if (live.queue.length > 0) renderQueue()
  renderRecentTimes()
}, 5000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') nudgeSocket()
})

// Two dashboard tabs for the same agent fight over one call. Say so.
try {
  const channel = new BroadcastChannel(`founderlive-host-${boot.me.agentId}`)
  const tabId = Math.random().toString(36).slice(2)
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { t?: string; from?: string }
    if (data?.from === tabId) return
    if (data?.t === 'hello') channel.postMessage({ t: 'here', from: tabId })
    if (data?.t === 'hello' || data?.t === 'here') toast('Your dashboard is open in another tab. Only one should be in control.', true)
  }
  channel.postMessage({ t: 'hello', from: tabId })
} catch {
  /* BroadcastChannel is unavailable in some embedded browsers */
}

export {}

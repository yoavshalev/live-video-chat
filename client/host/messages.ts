/** What each message from the Durable Object changes on the page. */

import type { ServerMessage } from '../../src/shared/protocol'
import { boot } from './boot'
import { announce, els, formatDuration, toast } from './dom'
import { live } from './state'
import { renderAgents, renderAll, renderCall, renderQueue, renderStatus } from './live'
import { alerts, chime, notifyJoin } from './attention'
import { refreshRecent } from './recent'
import { refreshInbox } from './inbox'
import { refreshMetrics } from './metrics'

export function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'HELLO':
      live.presence = message.payload.presence
      live.queue = message.payload.queue ?? []
      live.agents = message.payload.agents ?? []
      live.calls = message.payload.calls ?? []
      live.assignment = message.payload.settings.assignment
      els.assignment.value = live.assignment
      renderAll()
      return

    case 'PRESENCE_UPDATE':
      live.presence = message.payload
      renderStatus()
      return

    case 'QUEUE_UPDATE':
      live.queue = message.payload.queue
      live.agents = message.payload.agents
      live.calls = message.payload.calls
      renderQueue()
      renderAgents()
      renderCall()
      return

    case 'VISITOR_JOINED':
      // Announced rather than just drawn: the dashboard is often on a second
      // monitor, and someone arriving is the one event worth noticing.
      announce(`${message.payload.entry.firstName} joined the line from ${message.payload.entry.siteId}.`)
      if (alerts.soundEnabled) chime.play()
      notifyJoin(message.payload.entry.firstName, message.payload.entry.siteId)
      void refreshRecent()
      if (location.hash === '#inbox') void refreshInbox()
      return

    case 'VISITOR_LEFT':
      void refreshRecent()
      return

    case 'CALL_CONNECTING':
      // The server only sends an agent their own; the check is belt and braces.
      if (message.payload.agentId !== boot.me.agentId) return
      live.callSecret = message.payload.callSecret
      renderCall()
      return

    case 'CALL_STARTED':
      if (message.payload.agentId === boot.me.agentId) announce('Call connected.')
      return

    case 'CALL_ENDED':
      if (message.payload.agentId === boot.me.agentId) {
        live.callSecret = null
        announce(`Call ended after ${formatDuration(message.payload.durationSeconds)}.`)
      }
      live.calls = live.calls.filter((c) => c.callId !== message.payload.callId)
      renderCall()
      void refreshMetrics()
      void refreshRecent()
      return

    case 'ERROR':
      toast(message.payload.message, true)
      return

    default:
      return
  }
}

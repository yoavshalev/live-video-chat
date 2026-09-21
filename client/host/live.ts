/**
 * The Live tab: the header status and controls, the queue with each visitor's
 * site, the other agents, and your own call.
 *
 * Everything drawn here comes from `live` in ./state.ts, which the socket
 * owns. The functions are idempotent — call them whenever anything changed.
 */

import type { HostStatus, QueueEntryView } from '../../src/shared/protocol'
import { clientMsg } from '../../src/shared/protocol'
import { commandId } from '../shared/socket'
import { boot } from './boot'
import { els, formatDuration, shortenUrl, text, waitedFor } from './dom'
import { live, myCall, myStatus } from './state'
import { send } from './socket'
import { syncAlerts } from './attention'
import { renderTeam } from './team'
import { showTab } from './tabs'

let callTicker: ReturnType<typeof setInterval> | null = null

const STATUS_LABEL: Record<HostStatus, string> = {
  offline: 'Offline',
  available: 'Live — available',
  busy: 'Live — in call',
  paused: 'Live — paused'
}

const IDLE_COPY: Record<HostStatus, { title: string; body: string }> = {
  offline: { title: "You're offline", body: 'Go live and the widgets switch on within a second.' },
  available: { title: "You're live", body: 'Waiting for someone. When they join, they appear on the right.' },
  busy: { title: 'Connecting…', body: 'Your call is being set up.' },
  paused: { title: 'Paused', body: 'Widgets still show the team as live, but you will not be handed anyone.' }
}

export function renderAll(): void {
  renderStatus()
  renderQueue()
  renderAgents()
  renderCall()
}

/** The socket came or went. */
export function setConnected(connected: boolean): void {
  live.connected = connected
  if (!connected) {
    els.label.textContent = 'Reconnecting…'
    els.label.className = 'status-label muted'
  }
  syncControls()
}

export function renderStatus(): void {
  const mine = myStatus()
  els.dot.className = `dot ${mine}`
  els.label.textContent = live.connected ? STATUS_LABEL[mine] : 'Reconnecting…'
  els.label.className = `status-label ${mine === 'offline' ? 'muted' : ''}`

  els.live.textContent = mine === 'offline' ? 'Go live' : 'Go offline'
  els.live.className = mine === 'offline' ? 'btn-live' : 'btn-ghost'
  els.pause.classList.toggle('hidden', mine === 'offline')
  els.pause.textContent = mine === 'paused' ? 'Resume requests' : 'Pause new requests'
  els.waiting.textContent = String(live.presence?.queueLength ?? 0)

  els.idleDot.className = `dot ${mine} big`
  els.idleTitle.textContent = IDLE_COPY[mine].title
  const others = live.agents.filter((a) => a.id !== boot.me.agentId && a.status !== 'offline').length
  els.idleBody.textContent =
    mine === 'available' && live.queue.length > 0
      ? live.assignment === 'auto'
        ? `${live.queue.length} waiting. The next free agent is handed the next person automatically.`
        : `${live.queue.length} waiting. Press Accept to take the next person.`
      : mine === 'offline' && others > 0
        ? `${others} ${others === 1 ? 'colleague is' : 'colleagues are'} live. Go live to take a share of the line.`
        : IDLE_COPY[mine].body
  syncAlerts()
  syncControls()
}

export function syncControls(): void {
  els.live.disabled = !live.connected
  els.pause.disabled = !live.connected
  // Accepting is only meaningful when live, free, and somebody is waiting.
  els.acceptNext.disabled =
    !live.connected || myStatus() !== 'available' || live.queue.filter((e) => e.status === 'waiting').length === 0
}

export function renderQueue(): void {
  els.queue.replaceChildren(...live.queue.map(renderQueueEntry))
  els.queueEmpty.classList.toggle('hidden', live.queue.length > 0)
  els.waiting.textContent = String(live.queue.length)
  els.queueCount.textContent = String(live.queue.length)
  renderStatus()
}

function renderQueueEntry(entry: QueueEntryView, index: number): HTMLElement {
  const item = document.createElement('div')
  item.className = `queue-item${index === 0 ? ' next' : ''}${entry.status === 'invited' ? ' invited' : ''}`

  const head = document.createElement('div')
  head.className = 'between'
  const who = document.createElement('div')
  who.className = 'who'
  const assignedName = entry.assignedTo ? (live.agents.find((a) => a.id === entry.assignedTo)?.name ?? entry.assignedTo) : null
  who.append(
    ...[
      text('span', 'name', `${index + 1}. ${entry.firstName}`),
      // Where they came from — the one thing the sidebar exists to show.
      text('span', 'badge site', entry.siteId),
      entry.status === 'invited' ? text('span', 'badge invited', `Invited by ${assignedName}`) : null,
      entry.connected ? null : text('span', 'badge away', 'Tab away'),
      text('span', 'badge wait', waitedFor(entry.joinedAt))
    ].filter((node): node is HTMLElement => node !== null)
  )

  const actions = document.createElement('div')
  actions.className = 'row'
  const accept = document.createElement('button')
  accept.className = 'btn-primary'
  accept.type = 'button'
  accept.textContent = 'Accept'
  accept.disabled = myStatus() !== 'available' || entry.status === 'invited'
  accept.onclick = () => send(clientMsg('CALL_ACCEPT_VISITOR', { commandId: commandId(), visitorId: entry.visitorId }))
  const decline = document.createElement('button')
  decline.className = 'btn-ghost'
  decline.type = 'button'
  decline.textContent = 'Remove'
  decline.onclick = () => {
    if (!confirm(`Remove ${entry.firstName} from the line?`)) return
    send(clientMsg('CALL_DECLINE_VISITOR', { commandId: commandId(), visitorId: entry.visitorId }))
  }
  actions.append(accept, decline)
  head.append(who, actions)
  item.append(head)

  if (entry.question) item.append(text('div', 'question', entry.question))

  const meta = document.createElement('div')
  meta.className = 'tiny muted'
  const link = document.createElement('a')
  link.href = entry.pageUrl
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = shortenUrl(entry.pageUrl)
  meta.append(link)
  if (entry.email) meta.append(document.createTextNode(` · ${entry.email}`))
  if (entry.company) meta.append(document.createTextNode(` · ${entry.company}`))
  item.append(meta)
  return item
}

export function renderAgents(): void {
  const agents = live.agents
  els.agentsLive.textContent = `${agents.filter((a) => a.status !== 'offline').length} live`
  // The Agents tab shows the same status next to each team member.
  renderTeam()
  if (agents.length === 0) {
    els.agentsLiveList.replaceChildren(text('div', 'empty', 'No agents have connected yet.'))
    return
  }
  els.agentsLiveList.replaceChildren(
    ...agents.map((agent) => {
      const row = document.createElement('div')
      row.className = 'recent-row'
      const dot = document.createElement('span')
      dot.className = `dot ${agent.status}`
      dot.setAttribute('aria-hidden', 'true')
      row.append(
        dot,
        text('span', 'name', agent.id === boot.me.agentId ? `${agent.name} (you)` : agent.name),
        text('span', 'badge outcome', agent.status === 'busy' && agent.callWith ? `with ${agent.callWith}` : agent.status),
        agent.connected || agent.status === 'offline' ? text('span', '', '') : text('span', 'badge away', 'Tab away')
      )
      return row
    })
  )
}

export function renderCall(): void {
  const activeCall = myCall()
  if (!activeCall) {
    els.callPanel.classList.add('hidden')
    els.idlePanel.classList.remove('hidden')
    els.callStage.replaceChildren()
    if (callTicker) clearInterval(callTicker)
    callTicker = null
    syncControls()
    return
  }

  els.callPanel.classList.remove('hidden')
  els.idlePanel.classList.add('hidden')
  els.callName.textContent = activeCall.firstName
  els.callSite.textContent = activeCall.siteId
  els.callQuestion.textContent = activeCall.question ?? ''

  // The iframe is created once per call and never re-created on a re-render —
  // rebuilding it would drop the media session and hang up on someone.
  if (live.callSecret && !els.callStage.querySelector('iframe')) {
    const url = new URL(`${boot.baseUrl}/call`)
    url.searchParams.set('callId', activeCall.callId)
    url.searchParams.set('secret', live.callSecret)
    url.searchParams.set('who', 'host')
    url.searchParams.set('name', activeCall.firstName)
    url.searchParams.set('origin', location.origin)
    const frame = document.createElement('iframe')
    frame.src = url.toString()
    frame.allow = 'camera; microphone; autoplay; fullscreen; speaker-selection'
    frame.title = `Video call with ${activeCall.firstName}`
    els.callStage.replaceChildren(frame)
    // A call always brings you to the Live tab, wherever you were.
    showTab('live')
  }

  if (!callTicker) {
    const tick = () => {
      const current = myCall()
      const since = current?.connectedAt ?? current?.startedAt ?? Date.now()
      els.callTimer.textContent = formatDuration(Math.floor((Date.now() - since) / 1000))
    }
    tick()
    callTicker = setInterval(tick, 1000)
  }
  syncControls()
}

/** The header buttons, the assignment select, and the call iframe's relayed media events. Once. */
export function wireLiveControls(): void {
  els.live.onclick = () => {
    const mine = myStatus()
    if (mine === 'offline') {
      send(clientMsg('HOST_GO_LIVE', { commandId: commandId() }))
      return
    }
    const lastLive = live.agents.filter((a) => a.status !== 'offline').length <= 1
    if (myCall() || (lastLive && live.queue.length > 0)) {
      if (!confirm(myCall() ? 'End your current call and go offline?' : `${live.queue.length} waiting and you are the last agent live. Go offline anyway?`)) return
    }
    send(clientMsg('HOST_GO_OFFLINE', { commandId: commandId() }))
  }

  els.pause.onclick = () => {
    send(clientMsg(myStatus() === 'paused' ? 'HOST_RESUME' : 'HOST_PAUSE', { commandId: commandId() }))
  }

  els.acceptNext.onclick = () => send(clientMsg('CALL_ACCEPT_NEXT', { commandId: commandId() }))

  els.endCall.onclick = () => {
    if (!confirm('End this call?')) return
    send(clientMsg('CALL_END', { commandId: commandId(), reason: 'host_ended' }))
  }

  els.assignment.onchange = () => {
    live.assignment = els.assignment.value as typeof live.assignment
    send(clientMsg('HOST_SET_ASSIGNMENT', { commandId: commandId(), mode: live.assignment }))
  }

  // What the call iframe reports, relayed to the server over our socket.
  window.addEventListener('message', (event) => {
    if (event.origin !== new URL(boot.baseUrl).origin) return
    const data = event.data as { source?: string; type?: string; callId?: string } | null
    if (!data || data.source !== 'founderlive-call') return
    const callId = myCall()?.callId
    if (!callId || (data.callId && data.callId !== callId)) return
    if (data.type === 'media-joined') send(clientMsg('CALL_MEDIA_JOINED', { commandId: commandId(), callId }))
    else if (data.type === 'media-left') send(clientMsg('CALL_MEDIA_LEFT', { commandId: commandId(), callId }))
    else if (data.type === 'ended') send(clientMsg('CALL_END', { commandId: commandId(), reason: 'host_ended' }))
  })
}

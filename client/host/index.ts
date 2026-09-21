/**
 * The agent dashboard client.
 *
 * Hydrates the server-rendered skeleton in src/routes/host.tsx and then owns
 * everything that moves. The server never re-renders this page: a dashboard you
 * have to refresh is a dashboard that is quietly wrong while somebody waits.
 *
 * Nothing here decides anything. Every button sends a command and waits for the
 * Durable Object to say what happened — which is why two agents pressing ACCEPT
 * on the same visitor is safe, and why a button never optimistically shows a
 * state the server has not confirmed.
 *
 * Five tabs: Live (socket-driven), Embed and Agents (admin, plain fetches),
 * Clip (the recorder in ./media.ts), Inbox.
 */

import type {
  ActiveCallView,
  AgentView,
  AssignmentMode,
  HostStatus,
  PresenceView,
  QueueEntryView,
  ServerMessage
} from '../../src/shared/protocol'
import { clientMsg } from '../../src/shared/protocol'
import { describeDomain } from '../../src/shared/domains'
import { ReconnectingSocket, commandId } from '../shared/socket'
import { createChime } from '../shared/chime'
import { NAG_INTERVAL_MS, TITLE_FLASH_MS, nagTitle, shouldNag } from './alerts'
import { MediaSurface } from './media'

interface Site {
  id: string
  name: string
  allowedDomains: string[]
  position: 'bottom-right' | 'bottom-left'
  enabled: boolean
  offlineMode: 'show' | 'hide'
  agentLabel: string | null
}

interface AgentSummary {
  id: string
  name: string
  email: string
  role: 'admin' | 'agent'
  enabled: boolean
  hasPassword: boolean
  createdAt: number
  lastLoginAt: number | null
}

interface InboxItem {
  kind: 'join' | 'message'
  id: string
  name: string
  email: string | null
  company: string | null
  body: string | null
  siteId: string
  pageUrl: string | null
  at: number
  status: string
  agentName: string | null
}

interface Boot {
  baseUrl: string
  orgId: string
  orgName: string
  authMode: 'password' | 'access'
  me: { agentId: string; name: string; email: string; role: 'admin' | 'agent' }
  wsUrl: string
  sites: Site[]
  agents: AgentSummary[]
}

const boot = JSON.parse(document.getElementById('boot')?.textContent ?? '{}') as Boot
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const isAdmin = boot.me?.role === 'admin'

const els = {
  dot: $<HTMLSpanElement>('status-dot'),
  label: $<HTMLSpanElement>('status-label'),
  live: $<HTMLButtonElement>('btn-live'),
  pause: $<HTMLButtonElement>('btn-pause'),
  acceptNext: $<HTMLButtonElement>('btn-accept-next'),
  assignment: $<HTMLSelectElement>('assignment'),
  queue: $<HTMLDivElement>('queue'),
  queueEmpty: $<HTMLDivElement>('queue-empty'),
  queueCount: $<HTMLElement>('queue-count'),
  agentsLive: $<HTMLElement>('agents-live'),
  agentsLiveList: $<HTMLDivElement>('agents-live-list'),
  recent: $<HTMLDivElement>('recent'),
  callPanel: $<HTMLElement>('call-panel'),
  idlePanel: $<HTMLElement>('idle-panel'),
  idleDot: $<HTMLElement>('idle-dot'),
  idleTitle: $<HTMLElement>('idle-title'),
  idleBody: $<HTMLElement>('idle-body'),
  callName: $<HTMLElement>('call-name'),
  callSite: $<HTMLElement>('call-site'),
  callQuestion: $<HTMLElement>('call-question'),
  callTimer: $<HTMLElement>('call-timer'),
  callStage: $<HTMLDivElement>('call-stage'),
  endCall: $<HTMLButtonElement>('btn-end'),
  waiting: $<HTMLElement>('m-waiting'),
  calls: $<HTMLElement>('m-calls'),
  joins: $<HTMLElement>('m-joins'),
  avg: $<HTMLElement>('m-avg'),
  sites: $<HTMLDivElement>('sites'),
  inbox: $<HTMLDivElement>('inbox'),
  inboxRefresh: $<HTMLButtonElement>('btn-inbox-refresh'),
  siteForm: $<HTMLFormElement>('site-form'),
  siteName: $<HTMLInputElement>('site-name'),
  siteId: $<HTMLInputElement>('site-id'),
  agentsList: $<HTMLDivElement>('agents-list'),
  agentForm: $<HTMLFormElement>('agent-form'),
  passwordForm: $<HTMLFormElement>('password-form'),
  loopForm: $<HTMLFormElement>('loop-form'),
  loopFile: $<HTMLInputElement>('loop-file'),
  loopStatus: $<HTMLElement>('loop-status'),
  loopPreview: $<HTMLVideoElement>('loop-preview'),
  loopWrap: $<HTMLDivElement>('loop-wrap'),
  loopSound: $<HTMLButtonElement>('loop-sound'),
  btnRecord: $<HTMLButtonElement>('btn-record'),
  btnCheck: $<HTMLButtonElement>('btn-check'),
  toasts: $<HTMLDivElement>('toasts'),
  liveRegion: $<HTMLElement>('live-region'),
  sound: $<HTMLButtonElement>('btn-sound'),
  soundLocked: $<HTMLDivElement>('sound-locked')
}

let presence: PresenceView | null = null
let queue: QueueEntryView[] = []
let agents: AgentView[] = []
let calls: ActiveCallView[] = []
let assignment: AssignmentMode = 'auto'
let callSecret: string | null = null
let callTicker: ReturnType<typeof setInterval> | null = null
let connected = false
let sites: Site[] = boot.sites ?? []
let team: AgentSummary[] = boot.agents ?? []

/** My own call, if any — the one the main area shows. */
function myCall(): ActiveCallView | null {
  return calls.find((c) => c.agentId === boot.me.agentId) ?? null
}

/** My own status, as the server sees it. Drives every control in the header. */
function myStatus(): HostStatus {
  return agents.find((a) => a.id === boot.me.agentId)?.status ?? 'offline'
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'live' | 'embed' | 'clip' | 'inbox' | 'agents'
const TABS: Tab[] = ['live', 'embed', 'clip', 'inbox', 'agents']

/** The hash is the tab, so a reload lands where you were. */
function showTab(tab: Tab, pushHash = true): void {
  if (tab === 'embed' && !isAdmin) tab = 'live'
  for (const name of TABS) document.getElementById(`tab-${name}`)?.classList.toggle('hidden', name !== tab)
  for (const button of document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab))
  }
  if (pushHash && location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`)
  if (tab === 'inbox') void refreshInbox()
}
for (const button of document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')) {
  button.onclick = () => showTab(button.dataset.tab as Tab)
}
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1) as Tab
  if (TABS.includes(tab)) showTab(tab, false)
})
{
  const initial = location.hash.slice(1) as Tab
  showTab(TABS.includes(initial) ? initial : 'live', false)
}

// ─── Socket ──────────────────────────────────────────────────────────────────

const socket = new ReconnectingSocket({
  url: () => boot.wsUrl,
  onMessage: handleMessage,
  onStatus: (status) => {
    connected = status === 'open'
    if (!connected) {
      els.label.textContent = 'Reconnecting…'
      els.label.className = 'status-label muted'
    }
    syncControls()
  },
  onGiveUp: () => toast('Lost the connection to the server. Reload the page.', true)
})

function send(message: ReturnType<typeof clientMsg>): void {
  if (!socket.send(message)) toast('Not connected — that did not go through.', true)
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'HELLO':
      presence = message.payload.presence
      queue = message.payload.queue ?? []
      agents = message.payload.agents ?? []
      calls = message.payload.calls ?? []
      assignment = message.payload.settings.assignment
      els.assignment.value = assignment
      renderAll()
      return

    case 'PRESENCE_UPDATE':
      presence = message.payload
      renderStatus()
      return

    case 'QUEUE_UPDATE':
      queue = message.payload.queue
      agents = message.payload.agents
      calls = message.payload.calls
      renderQueue()
      renderAgents()
      renderCall()
      return

    case 'VISITOR_JOINED':
      // Announced rather than just drawn: the dashboard is often on a second
      // monitor, and someone arriving is the one event worth noticing.
      announce(`${message.payload.entry.firstName} joined the line from ${message.payload.entry.siteId}.`)
      if (soundEnabled) chime.play()
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
      callSecret = message.payload.callSecret
      renderCall()
      return

    case 'CALL_STARTED':
      if (message.payload.agentId === boot.me.agentId) announce('Call connected.')
      return

    case 'CALL_ENDED':
      if (message.payload.agentId === boot.me.agentId) {
        callSecret = null
        announce(`Call ended after ${formatDuration(message.payload.durationSeconds)}.`)
      }
      calls = calls.filter((c) => c.callId !== message.payload.callId)
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

// ─── Live tab ────────────────────────────────────────────────────────────────

function renderAll(): void {
  renderStatus()
  renderQueue()
  renderAgents()
  renderCall()
}

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

function renderStatus(): void {
  const mine = myStatus()
  els.dot.className = `dot ${mine}`
  els.label.textContent = connected ? STATUS_LABEL[mine] : 'Reconnecting…'
  els.label.className = `status-label ${mine === 'offline' ? 'muted' : ''}`

  els.live.textContent = mine === 'offline' ? 'Go live' : 'Go offline'
  els.live.className = mine === 'offline' ? 'btn-live' : 'btn-ghost'
  els.pause.classList.toggle('hidden', mine === 'offline')
  els.pause.textContent = mine === 'paused' ? 'Resume requests' : 'Pause new requests'
  els.waiting.textContent = String(presence?.queueLength ?? 0)

  els.idleDot.className = `dot ${mine} big`
  els.idleTitle.textContent = IDLE_COPY[mine].title
  const others = agents.filter((a) => a.id !== boot.me.agentId && a.status !== 'offline').length
  els.idleBody.textContent =
    mine === 'available' && queue.length > 0
      ? assignment === 'auto'
        ? `${queue.length} waiting. The next free agent is handed the next person automatically.`
        : `${queue.length} waiting. Press Accept to take the next person.`
      : mine === 'offline' && others > 0
        ? `${others} ${others === 1 ? 'colleague is' : 'colleagues are'} live. Go live to take a share of the line.`
        : IDLE_COPY[mine].body
  syncAlerts()
  syncControls()
}

function syncControls(): void {
  els.live.disabled = !connected
  els.pause.disabled = !connected
  // Accepting is only meaningful when live, free, and somebody is waiting.
  els.acceptNext.disabled =
    !connected || myStatus() !== 'available' || queue.filter((e) => e.status === 'waiting').length === 0
}

function renderQueue(): void {
  els.queue.replaceChildren(...queue.map(renderQueueEntry))
  els.queueEmpty.classList.toggle('hidden', queue.length > 0)
  els.waiting.textContent = String(queue.length)
  els.queueCount.textContent = String(queue.length)
  renderStatus()
}

function renderQueueEntry(entry: QueueEntryView, index: number): HTMLElement {
  const item = document.createElement('div')
  item.className = `queue-item${index === 0 ? ' next' : ''}${entry.status === 'invited' ? ' invited' : ''}`

  const head = document.createElement('div')
  head.className = 'between'
  const who = document.createElement('div')
  who.className = 'who'
  const assignedName = entry.assignedTo ? (agents.find((a) => a.id === entry.assignedTo)?.name ?? entry.assignedTo) : null
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

function renderAgents(): void {
  const live = agents.filter((a) => a.status !== 'offline')
  els.agentsLive.textContent = `${live.length} live`
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

/** textContent, always. Visitor-supplied strings never become markup. */
function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = content
  return node
}

function renderCall(): void {
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
  if (callSecret && !els.callStage.querySelector('iframe')) {
    const url = new URL(`${boot.baseUrl}/call`)
    url.searchParams.set('callId', activeCall.callId)
    url.searchParams.set('secret', callSecret)
    url.searchParams.set('who', 'host')
    url.searchParams.set('name', activeCall.firstName)
    url.searchParams.set('origin', location.origin)
    const frame = document.createElement('iframe')
    frame.src = url.toString()
    frame.allow = 'camera; microphone; autoplay; fullscreen'
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

// ─── Relayed media events ────────────────────────────────────────────────────

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

// ─── Controls ────────────────────────────────────────────────────────────────

els.live.onclick = () => {
  const mine = myStatus()
  if (mine === 'offline') {
    send(clientMsg('HOST_GO_LIVE', { commandId: commandId() }))
    return
  }
  const lastLive = agents.filter((a) => a.status !== 'offline').length <= 1
  if (myCall() || (lastLive && queue.length > 0)) {
    if (!confirm(myCall() ? 'End your current call and go offline?' : `${queue.length} waiting and you are the last agent live. Go offline anyway?`)) return
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
  assignment = els.assignment.value as AssignmentMode
  send(clientMsg('HOST_SET_ASSIGNMENT', { commandId: commandId(), mode: assignment }))
}

// ─── Alerts ──────────────────────────────────────────────────────────────────
//
// A chime that repeats while somebody is waiting and YOU are free to take them,
// a flashing tab title so a backgrounded dashboard still gets your attention,
// and a browser notification if you have allowed them. Which of these actually
// fire is decided in ./alerts.ts; this is only the plumbing.

const SOUND_KEY = 'founderlive.host.sound'
let soundEnabled = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
})()

const chime = createChime({ gain: 0.12 })
let nagTimer: ReturnType<typeof setInterval> | null = null
let titleTimer: ReturnType<typeof setInterval> | null = null
const originalTitle = document.title

async function unlockAudio(): Promise<void> {
  const ok = await chime.unlock()
  if (ok) syncAlerts()
}
window.addEventListener('pointerdown', () => void unlockAudio(), { capture: true })
window.addEventListener('keydown', () => void unlockAudio(), { capture: true })

function syncAlerts(): void {
  const nag = shouldNag({ queueLength: queue.length, hostStatus: myStatus(), soundEnabled })
  els.soundLocked.classList.toggle('hidden', !(nag && !chime.unlocked))
  if (nag) {
    if (!nagTimer) nagTimer = setInterval(() => chime.play(), NAG_INTERVAL_MS)
    if (!titleTimer) {
      let on = false
      titleTimer = setInterval(() => {
        on = !on
        document.title = on ? nagTitle(queue.length) : originalTitle
      }, TITLE_FLASH_MS)
    }
  } else {
    if (nagTimer) clearInterval(nagTimer)
    nagTimer = null
    if (titleTimer) clearInterval(titleTimer)
    titleTimer = null
    document.title = originalTitle
  }
}

function renderSoundToggle(): void {
  els.sound.textContent = soundEnabled ? 'Sound on' : 'Sound off'
  els.sound.setAttribute('aria-pressed', String(soundEnabled))
  els.sound.classList.toggle('muted-toggle', !soundEnabled)
}

els.sound.onclick = async () => {
  soundEnabled = !soundEnabled
  try {
    localStorage.setItem(SOUND_KEY, soundEnabled ? 'on' : 'off')
  } catch {
    /* per-browser preference; losing it costs one extra click */
  }
  renderSoundToggle()
  if (soundEnabled) {
    await unlockAudio()
    chime.play()
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {})
  }
  syncAlerts()
}
renderSoundToggle()

function notifyJoin(firstName: string, siteId: string): void {
  if (document.visibilityState === 'visible') return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(`${firstName} is waiting to talk`, { body: `From ${siteId}. Open the dashboard to accept.`, tag: 'founderlive-host' })
  } catch {
    /* some browsers need a service worker for this */
  }
}

// ─── Recent activity ─────────────────────────────────────────────────────────

function renderRecentTimes(): void {
  for (const node of els.recent.querySelectorAll<HTMLElement>('.when[data-at]')) node.textContent = timeAgo(Number(node.dataset.at))
}

async function refreshRecent(): Promise<void> {
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

// ─── Inbox ───────────────────────────────────────────────────────────────────

async function refreshInbox(): Promise<void> {
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

els.inboxRefresh.onclick = () => void refreshInbox()

// ─── Embed tab (admins) ──────────────────────────────────────────────────────

function snippetFor(site: Site): string {
  return `<script\n  src="${boot.baseUrl}/widget.js"\n  data-site="${site.id}"\n  data-position="${site.position}"\n  defer\n></script>`
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}

async function siteRequest(path: string, init: RequestInit): Promise<Site> {
  return (await api<{ site: Site }>(path, init)).site
}

async function patchSite(id: string, patch: Partial<Pick<Site, 'enabled' | 'offlineMode'>> & { agentLabel?: string }): Promise<void> {
  try {
    upsertSite(await siteRequest(`/api/host/sites/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }))
    toast('Saved. Widgets pick it up within a minute.')
  } catch (error) {
    toast(describe(error), true)
  }
}

function upsertSite(site: Site): void {
  const index = sites.findIndex((s) => s.id === site.id)
  if (index >= 0) sites[index] = site
  else sites.push(site)
  sites.sort((a, b) => a.name.localeCompare(b.name))
  renderSites()
}

function renderSites(): void {
  if (!els.sites) return
  if (sites.length === 0) {
    els.sites.replaceChildren(text('div', 'empty', 'No sites yet. Create one on the left.'))
    return
  }
  els.sites.replaceChildren(...sites.map(renderSiteCard))
}

function renderSiteCard(site: Site): HTMLElement {
  const card = document.createElement('section')
  card.className = `card stack site-card${site.enabled ? '' : ' disabled'}`

  const head = document.createElement('div')
  head.className = 'between'
  const title = document.createElement('div')
  title.className = 'row'
  title.append(text('h2', '', site.name), text('span', 'badge', site.id))
  const toggle = document.createElement('label')
  toggle.className = 'switch'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = site.enabled
  checkbox.onchange = () => void patchSite(site.id, { enabled: checkbox.checked })
  toggle.append(checkbox, document.createTextNode(site.enabled ? 'Enabled' : 'Disabled'))
  head.append(title, toggle)
  card.append(head)

  // Widget wording for this site.
  const wording = document.createElement('div')
  wording.className = 'two'
  const labelWrap = document.createElement('div')
  labelWrap.append(text('label', '', 'Name in the widget'))
  const label = document.createElement('input')
  label.type = 'text'
  label.maxLength = 40
  label.placeholder = 'Agent'
  label.value = site.agentLabel ?? ''
  label.setAttribute('aria-label', `Name shown in the widget on ${site.name}`)
  label.onchange = () => void patchSite(site.id, { agentLabel: label.value })
  labelWrap.append(label, text('div', 'tiny muted', 'Used as "… is live" and "Talk to …". Empty means "Agent".'))
  const modeWrap = document.createElement('div')
  modeWrap.append(text('label', '', 'When nobody is live'))
  const mode = document.createElement('select')
  mode.setAttribute('aria-label', `Offline behaviour on ${site.name}`)
  for (const [value, caption] of [['show', 'Show "offline" with a message form'], ['hide', 'Show nothing at all']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = caption
    option.selected = site.offlineMode === value
    mode.append(option)
  }
  mode.onchange = () => void patchSite(site.id, { offlineMode: mode.value as 'show' | 'hide' })
  modeWrap.append(mode, text('div', 'tiny muted', 'A hidden widget still appears the moment an agent goes live.'))
  wording.append(labelWrap, modeWrap)
  card.append(wording)

  // Domains.
  card.append(text('label', '', 'Domains'))
  const chips = document.createElement('div')
  chips.className = 'chips'
  if (site.allowedDomains.length === 0) chips.append(text('span', 'site-error', 'No domains — the widget will refuse to load anywhere for this site.'))
  for (const domain of site.allowedDomains) {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.title = describeDomain(domain)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `Remove ${domain}`)
    remove.onclick = async () => {
      if (!confirm(`Remove ${domain} from ${site.name}? The widget will stop loading there within a minute.`)) return
      try {
        upsertSite(await siteRequest(`/api/host/sites/${site.id}/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' }))
      } catch (error) {
        toast(describe(error), true)
      }
    }
    chip.append(text('span', '', domain), text('span', 'sub', '+ subdomains'), remove)
    chips.append(chip)
  }
  card.append(chips)

  const form = document.createElement('form')
  form.className = 'domain-form'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'example.com'
  input.setAttribute('aria-label', `Add a domain to ${site.name}`)
  input.autocomplete = 'off'
  const add = document.createElement('button')
  add.type = 'submit'
  add.className = 'btn-ghost'
  add.textContent = 'Add domain'
  const error = text('div', 'site-error hidden', '')
  form.onsubmit = async (event) => {
    event.preventDefault()
    error.classList.add('hidden')
    add.disabled = true
    try {
      upsertSite(await siteRequest(`/api/host/sites/${site.id}/domains`, { method: 'POST', body: JSON.stringify({ domain: input.value }) }))
      toast(`Added. Live on ${input.value.trim()} within a minute.`)
    } catch (err) {
      error.textContent = describe(err)
      error.classList.remove('hidden')
      add.disabled = false
    }
  }
  form.append(input, add)
  card.append(form, error)

  card.append(text('label', '', 'Snippet'))
  const pre = document.createElement('pre')
  pre.className = 'embed-snippet mono'
  pre.textContent = snippetFor(site)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'btn-ghost'
  copy.textContent = 'Copy snippet'
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(snippetFor(site))
      toast('Snippet copied.')
    } catch {
      toast('Could not copy — select it manually.', true)
    }
  }
  card.append(pre, copy)
  return card
}

if (els.siteForm) {
  els.siteForm.onsubmit = async (event) => {
    event.preventDefault()
    const button = els.siteForm.querySelector('button')
    if (button) button.disabled = true
    try {
      const created = await siteRequest('/api/host/sites', { method: 'POST', body: JSON.stringify({ id: els.siteId.value, name: els.siteName.value }) })
      upsertSite(created)
      els.siteForm.reset()
      delete els.siteId.dataset.touched
      toast(`${created.name} created. Add its domain, then paste the snippet.`)
    } catch (error) {
      toast(describe(error), true)
    } finally {
      if (button) button.disabled = false
    }
  }
  els.siteName.oninput = () => {
    if (els.siteId.dataset.touched) return
    els.siteId.value = els.siteName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  }
  els.siteId.oninput = () => {
    els.siteId.dataset.touched = '1'
  }
}

// ─── Agents tab ──────────────────────────────────────────────────────────────

function upsertAgent(agent: AgentSummary): void {
  const index = team.findIndex((a) => a.id === agent.id)
  if (index >= 0) team[index] = agent
  else team.push(agent)
  renderTeam()
}

function renderTeam(): void {
  if (team.length === 0) {
    els.agentsList.replaceChildren(text('div', 'empty', 'No agents yet.'))
    return
  }
  els.agentsList.replaceChildren(
    ...team.map((agent) => {
      const row = document.createElement('div')
      row.className = `inbox-row${agent.enabled ? '' : ' disabled'}`
      const head = document.createElement('div')
      head.className = 'who'
      const live = agents.find((a) => a.id === agent.id)
      head.append(
        text('span', 'name', agent.id === boot.me.agentId ? `${agent.name} (you)` : agent.name),
        text('span', 'badge', agent.role),
        text('span', `badge outcome ${live?.status ?? 'offline'}`, live?.status ?? 'offline'),
        ...(agent.enabled ? [] : [text('span', 'badge away', 'disabled')]),
        text('span', 'tiny muted', agent.email)
      )
      row.append(head)
      row.append(text('div', 'tiny muted', agent.lastLoginAt ? `Last signed in ${timeAgo(agent.lastLoginAt)}` : 'Never signed in'))

      if (isAdmin) {
        const actions = document.createElement('div')
        actions.className = 'row'
        const roleButton = document.createElement('button')
        roleButton.type = 'button'
        roleButton.className = 'btn-ghost'
        roleButton.textContent = agent.role === 'admin' ? 'Make agent' : 'Make admin'
        roleButton.onclick = () => void patchAgent(agent.id, { role: agent.role === 'admin' ? 'agent' : 'admin' })
        const enableButton = document.createElement('button')
        enableButton.type = 'button'
        enableButton.className = 'btn-ghost'
        enableButton.textContent = agent.enabled ? 'Disable' : 'Enable'
        enableButton.onclick = () => {
          if (agent.enabled && !confirm(`Disable ${agent.name}? They will be signed out on their next page load.`)) return
          void patchAgent(agent.id, { enabled: !agent.enabled })
        }
        actions.append(roleButton, enableButton)
        if (boot.authMode !== 'access') {
          const resetButton = document.createElement('button')
          resetButton.type = 'button'
          resetButton.className = 'btn-ghost'
          resetButton.textContent = 'Reset password'
          resetButton.onclick = () => {
            const password = prompt(`New temporary password for ${agent.name} (12+ characters):`)
            if (password) void patchAgent(agent.id, { password })
          }
          actions.append(resetButton)
        }
        row.append(actions)
      }
      return row
    })
  )
}

async function patchAgent(id: string, patch: { role?: 'admin' | 'agent'; enabled?: boolean; password?: string; name?: string }): Promise<void> {
  try {
    const { agent } = await api<{ agent: AgentSummary }>(`/api/host/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    upsertAgent(agent)
    toast(patch.password ? 'Password reset.' : 'Saved.')
  } catch (error) {
    toast(describe(error), true)
  }
}

if (els.agentForm) {
  els.agentForm.onsubmit = async (event) => {
    event.preventDefault()
    const button = els.agentForm.querySelector('button[type="submit"]') as HTMLButtonElement | null
    if (button) button.disabled = true
    try {
      const { agent } = await api<{ agent: AgentSummary }>('/api/host/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: $<HTMLInputElement>('agent-name').value,
          email: $<HTMLInputElement>('agent-email').value,
          password: (document.getElementById('agent-password') as HTMLInputElement | null)?.value ?? '',
          role: $<HTMLInputElement>('agent-admin').checked ? 'admin' : 'agent'
        })
      })
      upsertAgent(agent)
      els.agentForm.reset()
      toast(`${agent.name} added. They sign in at ${boot.baseUrl}/host with the password you gave them.`)
    } catch (error) {
      toast(describe(error), true)
    } finally {
      if (button) button.disabled = false
    }
  }
}

if (els.passwordForm) {
  els.passwordForm.onsubmit = async (event) => {
    event.preventDefault()
    const status = $<HTMLElement>('pw-status')
    try {
      await api<{ ok: true }>('/api/host/me/password', {
        method: 'POST',
        body: JSON.stringify({ current: $<HTMLInputElement>('pw-current').value, next: $<HTMLInputElement>('pw-next').value })
      })
      els.passwordForm.reset()
      status.textContent = 'Password updated.'
    } catch (error) {
      status.textContent = describe(error)
    }
  }
}

// ─── Clip tab ────────────────────────────────────────────────────────────────

const media = new MediaSurface(
  {
    modal: $<HTMLDivElement>('media-modal'),
    title: $<HTMLElement>('media-title'),
    hint: $<HTMLElement>('media-hint'),
    preview: $<HTMLVideoElement>('media-preview'),
    playback: $<HTMLVideoElement>('media-playback'),
    level: $<HTMLElement>('media-level'),
    levelBar: $<HTMLElement>('media-level-bar'),
    cameraSelect: $<HTMLSelectElement>('media-camera'),
    micSelect: $<HTMLSelectElement>('media-mic'),
    speakerWrap: $<HTMLElement>('media-speaker-wrap'),
    speakerSelect: $<HTMLSelectElement>('media-speaker'),
    speakerTest: $<HTMLButtonElement>('media-speaker-test'),
    error: $<HTMLElement>('media-error'),
    timer: $<HTMLElement>('media-timer'),
    record: $<HTMLButtonElement>('media-record'),
    stop: $<HTMLButtonElement>('media-stop'),
    retake: $<HTMLButtonElement>('media-retake'),
    use: $<HTMLButtonElement>('media-use'),
    close: $<HTMLButtonElement>('media-close'),
    sound: $<HTMLButtonElement>('media-sound')
  },
  {
    upload: async (clip, clipType, poster) => {
      await uploadMedia('loop', clip, clipType.includes('mp4') ? 'loop.mp4' : 'loop.webm')
      if (poster) {
        try {
          await uploadMedia('poster', poster, 'poster.jpg')
        } catch {
          /* the clip is already live */
        }
      }
      toast('Intro clip updated. Widgets pick it up immediately.')
    },
    onStatus: (message, isError) => {
      els.loopStatus.textContent = message
      els.loopStatus.style.color = isError ? 'var(--busy)' : ''
    }
  }
)

async function uploadMedia(kind: 'loop' | 'poster', blob: Blob, filename: string): Promise<void> {
  const body = new FormData()
  body.append('file', blob, filename)
  const response = await fetch(`/host/media/${kind}`, { method: 'POST', body })
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; url?: string }
  if (!response.ok || !result.ok) throw new Error(result.error ?? `upload failed (${response.status})`)
  if (kind === 'loop' && result.url) {
    els.loopPreview.src = result.url
    els.loopWrap.classList.remove('hidden')
    document.getElementById('loop-empty')?.classList.add('hidden')
    void els.loopPreview.play().catch(() => {})
    showTab('clip')
    els.loopWrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
    els.loopWrap.classList.remove('landed')
    void els.loopWrap.offsetWidth
    els.loopWrap.classList.add('landed')
  }
}

/**
 * Looping by hand rather than with the `loop` attribute: a recording's audio and
 * video tracks rarely end on the same millisecond, and the native wrap-around
 * restarts them from different points, so the gap compounds every pass.
 */
function loopCleanly(video: HTMLVideoElement): void {
  video.loop = false
  video.onended = () => {
    video.currentTime = 0
    void video.play().catch(() => {})
  }
}
loopCleanly(els.loopPreview)

els.loopSound.onclick = () => {
  els.loopPreview.muted = !els.loopPreview.muted
  els.loopSound.textContent = els.loopPreview.muted ? 'Sound off' : 'Sound on'
  els.loopSound.classList.toggle('off', els.loopPreview.muted)
  els.loopSound.setAttribute('aria-pressed', String(!els.loopPreview.muted))
  if (!els.loopPreview.muted) void els.loopPreview.play().catch(() => {})
}

els.btnRecord.onclick = () => void media.open('record')
els.btnCheck.onclick = () => void media.open('check')

els.loopForm.onsubmit = async (event) => {
  event.preventDefault()
  const file = els.loopFile.files?.[0]
  if (!file) {
    els.loopStatus.textContent = 'Choose a file first.'
    return
  }
  els.loopStatus.textContent = 'Uploading…'
  try {
    await uploadMedia('loop', file, file.name)
    els.loopStatus.textContent = 'Uploaded. Every widget picks it up on its next load.'
  } catch (error) {
    els.loopStatus.textContent = describe(error)
  }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

async function refreshMetrics(): Promise<void> {
  try {
    const response = await fetch('/api/host/metrics')
    if (!response.ok) return
    const metrics = (await response.json()) as { callsCompleted: number; queueJoins: number; averageCallSeconds: number | null }
    els.calls.textContent = String(metrics.callsCompleted)
    els.joins.textContent = String(metrics.queueJoins)
    els.avg.textContent = metrics.averageCallSeconds ? `${Math.round(metrics.averageCallSeconds / 60)}m` : '—'
  } catch {
    /* the numbers are a nicety; the queue is not */
  }
}

// ─── Multi-tab ───────────────────────────────────────────────────────────────

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

// ─── Small helpers ───────────────────────────────────────────────────────────

function toast(message: string, isError = false): void {
  const node = document.createElement('div')
  node.className = `toast${isError ? ' error' : ''}`
  node.textContent = message
  els.toasts.append(node)
  setTimeout(() => node.remove(), 6000)
}

function announce(message: string): void {
  els.liveRegion.textContent = message
  els.liveRegion.classList.remove('hidden')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`
}

function waitedFor(joinedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - joinedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`.slice(0, 60)
  } catch {
    return url.slice(0, 60)
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

renderSites()
renderTeam()
renderRecentTimes()
socket.connect()
void refreshMetrics()

setInterval(() => {
  if (queue.length > 0) renderQueue()
  renderRecentTimes()
}, 5000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') socket.nudge()
})

export {}

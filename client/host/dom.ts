/** The dashboard's elements, and the small DOM and formatting helpers every tab uses. */

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export const els = {
  // Header and status.
  dot: $<HTMLSpanElement>('status-dot'),
  label: $<HTMLSpanElement>('status-label'),
  live: $<HTMLButtonElement>('btn-live'),
  pause: $<HTMLButtonElement>('btn-pause'),
  sound: $<HTMLButtonElement>('btn-sound'),
  soundLocked: $<HTMLDivElement>('sound-locked'),
  liveRegion: $<HTMLElement>('live-region'),
  toasts: $<HTMLDivElement>('toasts'),

  // Live tab.
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

  // Embed, Inbox, Agents, Clip tabs.
  sites: $<HTMLDivElement>('sites'),
  siteForm: $<HTMLFormElement>('site-form'),
  siteName: $<HTMLInputElement>('site-name'),
  siteId: $<HTMLInputElement>('site-id'),
  inbox: $<HTMLDivElement>('inbox'),
  inboxRefresh: $<HTMLButtonElement>('btn-inbox-refresh'),
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
  btnCheck: $<HTMLButtonElement>('btn-check')
}

/** textContent, always. Visitor-supplied strings never become markup. */
export function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = content
  return node
}

export function toast(message: string, isError = false): void {
  const node = document.createElement('div')
  node.className = `toast${isError ? ' error' : ''}`
  node.textContent = message
  els.toasts.append(node)
  setTimeout(() => node.remove(), 6000)
}

/** For screen readers, and for a dashboard on a second monitor. */
export function announce(message: string): void {
  els.liveRegion.textContent = message
  els.liveRegion.classList.remove('hidden')
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${String(Math.max(0, seconds % 60)).padStart(2, '0')}`
}

export function waitedFor(joinedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - joinedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`.slice(0, 60)
  } catch {
    return url.slice(0, 60)
  }
}

/**
 * The widget: one instance per page, owning the state, the socket and the
 * shadow root. What each screen looks like lives in ./views; this class
 * decides which screen, when, and what the server is told.
 *
 * Constraints, all consequences of running inside somebody else's page:
 *   - One custom element with a shadow root. Nothing leaks out, nothing leaks in.
 *   - No framework, no runtime dependency, no `innerHTML` (see dom.ts).
 *   - The asset is static and cached for an hour; everything dynamic arrives over
 *     /embed/config and the socket, so presence can change in seconds while the
 *     script itself is never re-downloaded.
 *   - Camera and microphone are never touched here. They are requested inside the
 *     call iframe, at the moment the visitor joins, and not one step earlier.
 */

import type { HostProfileView, PresenceView, QueuePositionView, SelfView, ServerMessage } from '../../src/shared/protocol'
import { clientMsg } from '../../src/shared/protocol'
import { ReconnectingSocket, commandId } from '../shared/socket'
import { WIDGET_STYLES } from './styles'
import { el, replace } from './dom'
import type { CallHandle, Draft, EmbedConfig, InitOptions, View } from './types'
import { visitorIdentity } from './identity'
import { Attention } from './attention'
import { ClipView } from './clip'
import { renderBubble } from './views/bubble'
import { renderPanel } from './views/panel'
import { formatClock } from './views/invited'

export class Widget {
  // ── Read by the views ────────────────────────────────────────────────────
  readonly baseUrl: string
  readonly options: InitOptions
  readonly visitorId = visitorIdentity()
  readonly attention = new Attention(() => this.name())
  readonly clip = new ClipView()

  config: EmbedConfig | null = null
  presence: PresenceView | null = null
  profile: HostProfileView | null = null
  position: QueuePositionView | null = null
  call: CallHandle | null = null
  inviteExpiresAt: number | null = null
  /** Who is inviting us, when the server says. Falls back to the site label. */
  inviteAgentName: string | null = null
  view: View = 'collapsed'
  busy = false
  formError: string | null = null
  /**
   * What the visitor has typed so far.
   *
   * Kept outside the DOM because any render rebuilds the form — and renders are
   * driven by presence, which changes whenever anybody else joins or leaves. A
   * stranger joining the queue must not wipe what someone is halfway through
   * typing.
   */
  readonly draft: Draft = { firstName: '', email: '', question: '' }
  iframeFallback = false
  /** The call surface reported a failure, so the panel's close control comes back. */
  callErrored = false

  // ── Private plumbing ─────────────────────────────────────────────────────
  private mount: HTMLElement | null = null
  private root: ShadowRoot | null = null
  private self: SelfView | null = null
  /** What the call view was last rendered for; see render(). */
  private callRenderKey: string | null = null
  private socket: ReconnectingSocket | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  private joinTimeout: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(baseUrl: string, options: InitOptions) {
    this.baseUrl = baseUrl
    this.options = options
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      this.config = await this.fetchConfig()
    } catch {
      // A failed bootstrap is silent on purpose. This runs on somebody's
      // marketing site; a broken support widget must not produce console noise
      // or a visible error on their page.
      return
    }
    if (this.destroyed) return

    this.presence = this.config.presence
    this.profile = this.config.host
    this.render()
    this.openSocket()
    this.track('widget_impression')
    this.emit('ready', { status: this.presence?.status ?? 'offline' })

    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pageshow', this.onVisibility)
    // Attached once for the widget's lifetime rather than per call: a call that
    // ends abnormally never reaches the cleanup path, and the handler is inert
    // when there is no call to match against.
    window.addEventListener('message', this.onCallMessage)
    // One-time: unlocks the notification sound, which browsers refuse until the
    // visitor has interacted with the document.
    window.addEventListener('pointerdown', this.onFirstInteraction, { once: true, capture: true })
    window.addEventListener('keydown', this.onFirstInteraction, { once: true, capture: true })
  }

  destroy(): void {
    this.destroyed = true
    this.socket?.close()
    this.stopPolling()
    this.stopCountdown()
    this.clearJoinTimeout()
    this.attention.stopTitleFlash()
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pageshow', this.onVisibility)
    window.removeEventListener('message', this.onCallMessage)
    this.mount?.remove()
    this.mount = null
    this.root = null
    this.clip.reset()
  }

  open(): void {
    if (this.view !== 'collapsed') return
    this.setView(this.restoredView())
    this.track('widget_opened')
    this.emit('opened')
  }

  close(): void {
    if (this.view === 'call') {
      // A healthy call is not something a stray click should close. A failed one
      // has to be closable, and closing it must actually release the host rather
      // than leaving them waiting on somebody who has given up.
      if (!this.callErrored) return
      this.send(clientMsg('CALL_END', { commandId: commandId(), reason: 'visitor_left' }))
      this.call = null
      this.callErrored = false
    }
    this.setView('collapsed')
    this.emit('closed')
  }

  /**
   * What the sheet chevron does. During a live call that is "hang up" — a
   * chevron that silently refuses is worse than no chevron, and on a phone it is
   * the only control outside the call iframe.
   */
  dismiss(): void {
    if (this.view === 'call' && !this.callErrored) {
      this.send(clientMsg('CALL_END', { commandId: commandId(), reason: 'visitor_left' }))
      return
    }
    this.close()
  }

  status(): { presence: PresenceView | null; self: SelfView | null; view: View } {
    return { presence: this.presence, self: this.self, view: this.view }
  }

  private onFirstInteraction = (): void => {
    this.attention.interacted = true
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      this.attention.stopTitleFlash()
      // A frozen tab's socket is usually already dead even though `readyState`
      // has not caught up. Nudging beats waiting out the backoff.
      this.socket?.nudge()
    }
  }

  // ── Server ───────────────────────────────────────────────────────────────

  private async fetchConfig(): Promise<EmbedConfig> {
    const response = await fetch(
      `${this.baseUrl}/embed/config?siteId=${encodeURIComponent(this.options.siteId)}`,
      { credentials: 'omit' }
    )
    if (!response.ok) throw new Error(`config ${response.status}`)
    return (await response.json()) as EmbedConfig
  }

  private openSocket(): void {
    const config = this.config
    if (!config) return

    this.socket = new ReconnectingSocket({
      url: () =>
        `${config.wsUrl}?siteId=${encodeURIComponent(this.options.siteId)}&visitorId=${encodeURIComponent(this.visitorId)}`,
      onMessage: (message) => this.onMessage(message),
      onStatus: (status) => {
        if (status === 'open') this.stopPolling()
      },
      // Sockets are blocked outright on some corporate networks. Presence still
      // has to be roughly right there, so we degrade to slow polling rather than
      // showing a permanently stale bubble.
      onGiveUp: () => this.startPolling()
    })
    this.socket.connect()
  }

  private startPolling(): void {
    if (this.pollTimer) return
    const poll = async () => {
      try {
        const config = await this.fetchConfig()
        this.presence = config.presence
        this.profile = config.host
        this.render()
      } catch {
        /* keep trying on the next tick */
      }
    }
    void poll()
    this.pollTimer = setInterval(poll, 20_000)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  send(message: ReturnType<typeof clientMsg>): boolean {
    return this.socket?.send(message) ?? false
  }

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'HELLO':
        this.presence = message.payload.presence
        this.profile = message.payload.hostProfile
        if (message.payload.self) this.applySelf(message.payload.self)
        this.render()
        return

      case 'PRESENCE_UPDATE': {
        const wasOffline = this.presence?.status === 'offline'
        this.presence = message.payload
        // The host coming back while somebody is staring at the offline form is
        // the single best moment this product has. Move them to it.
        if (wasOffline && message.payload.status !== 'offline' && this.view === 'offline_form') {
          this.setView('live')
          return
        }
        this.render()
        return
      }

      case 'QUEUE_POSITION_UPDATE':
        this.position = message.payload
        // This message IS the confirmation that the join landed — there is no
        // separate ack. Treating it as "only useful once already waiting" left
        // the join form stuck on "Joining…" forever, which is exactly what it
        // did in production.
        if (this.view === 'form' || this.view === 'live') {
          this.setView('waiting')
          return
        }
        if (this.view === 'waiting') this.render()
        return

      case 'SELF_UPDATE':
        this.applySelf(message.payload)
        this.render()
        return

      case 'CALL_INVITATION':
        this.call = { callId: message.payload.callId, secret: message.payload.callSecret }
        this.inviteExpiresAt = message.payload.expiresAt
        this.inviteAgentName = message.payload.agentName || null
        this.setView('invited')
        this.attention.alertVisitor()
        this.emit('invited', { callId: message.payload.callId })
        return

      case 'CALL_INVITATION_EXPIRED':
        this.call = null
        this.inviteExpiresAt = null
        this.position = null
        this.stopCountdown()
        this.setView('live')
        this.emit('inviteexpired', {})
        return

      case 'CALL_CONNECTING':
        this.call = { callId: message.payload.callId, secret: message.payload.callSecret }
        this.inviteAgentName = message.payload.agentName || this.inviteAgentName
        this.inviteExpiresAt = null
        this.stopCountdown()
        this.setView('call')
        return

      case 'CALL_STARTED':
        // Broadcast, so every widget everywhere sees it. Only the one in this
        // call should fire the event its host page is listening for.
        if (this.call?.callId !== message.payload.callId) return
        this.emit('callstarted', { callId: message.payload.callId })
        return

      case 'CALL_ENDED':
        if (this.call?.callId !== message.payload.callId) return
        this.call = null
        this.position = null
        this.setView('ended')
        this.emit('callended', { reason: message.payload.reason })
        return

      case 'ERROR':
        this.clearJoinTimeout()
        this.busy = false
        this.formError = message.payload.message
        // "You are already in line" is a reconciliation, not a failure: the
        // position update that follows puts the visitor where they belong.
        if (message.payload.code === 'already_queued') {
          this.formError = null
          this.setView('waiting')
          return
        }
        this.render()
        return

      default:
        return
    }
  }

  private applySelf(self: SelfView): void {
    this.self = self
    this.position = self.position
    if (self.invite) {
      this.call = { callId: self.invite.callId, secret: self.invite.callSecret }
      this.inviteExpiresAt = self.invite.expiresAt
      this.inviteAgentName = self.invite.agentName || null
    }

    // Restore what the server says we are, so a refresh mid-queue lands back in
    // the right place instead of at the start of the funnel. 'waiting' wins even
    // over the call screen: it is what the server sends when the agent who was
    // about to take us went offline and we are back in line for someone else.
    if (self.status === 'waiting') {
      this.call = null
      this.callErrored = false
      this.stopCountdown()
      this.setView('waiting')
    }
    else if (self.status === 'invited') this.setView('invited')
    else if (self.status === 'in_call' || self.status === 'connecting') this.setView('call')
    else if (self.status === 'completed' && this.view === 'call') this.setView('ended')
    else if (
      (self.status === 'expired' || self.status === 'left' || self.status === 'declined') &&
      (this.view === 'waiting' || this.view === 'invited')
    ) {
      this.position = null
      this.call = null
      this.setView('live')
    }
  }

  /** Where an `open()` should land, given what the server last told us about us. */
  private restoredView(): View {
    if (this.presence?.status === 'offline') return 'offline_form'
    if (this.self?.status === 'waiting') return 'waiting'
    if (this.self?.status === 'invited') return 'invited'
    if (this.self?.status === 'in_call' || this.self?.status === 'connecting') return 'call'
    return 'live'
  }

  /** The call page reports through postMessage; only our own page, and only our own call. */
  private onCallMessage = (event: MessageEvent): void => {
    // Anything else on the page can post messages too, so both the origin and
    // the envelope are checked.
    if (event.origin !== new URL(this.baseUrl).origin) return
    const data = event.data as { source?: string; type?: string; callId?: string } | null
    if (!data || data.source !== 'founderlive-call') return
    const callId = this.call?.callId
    if (!callId || (data.callId && data.callId !== callId)) return

    switch (data.type) {
      case 'media-joined':
        this.send(clientMsg('CALL_MEDIA_JOINED', { commandId: commandId(), callId }))
        return
      case 'media-left':
        this.send(clientMsg('CALL_MEDIA_LEFT', { commandId: commandId(), callId }))
        return
      case 'ended':
        this.send(clientMsg('CALL_END', { commandId: commandId(), reason: 'visitor_left' }))
        // Leave the call screen now rather than when the server confirms. If
        // the socket happens to be down, the confirmation never comes, and a
        // visitor who pressed End must not be left staring at the call.
        this.call = null
        this.position = null
        this.setView('ended')
        this.emit('callended', { reason: 'visitor_left' })
        return
      case 'iframe-blocked':
        this.iframeFallback = true
        this.callErrored = true
        this.render()
        return
      case 'call-error':
        this.callErrored = true
        this.render()
        return
      default:
        return
    }
  }

  // ── Timers ───────────────────────────────────────────────────────────────

  startJoinTimeout(): void {
    this.clearJoinTimeout()
    this.joinTimeout = setTimeout(() => {
      if (this.view !== 'form' || !this.busy) return
      this.busy = false
      this.formError = 'That did not go through. Check your connection and try again.'
      this.render()
    }, 12_000)
  }

  private clearJoinTimeout(): void {
    if (this.joinTimeout) clearTimeout(this.joinTimeout)
    this.joinTimeout = null
  }

  startCountdown(label: HTMLElement, bar: HTMLElement, total: number): void {
    this.stopCountdown()
    const tick = () => {
      const remaining = Math.max(0, Math.round(((this.inviteExpiresAt ?? 0) - Date.now()) / 1000))
      label.textContent = `Your spot is ready — ${formatClock(remaining)}`
      label.classList.toggle('urgent', remaining <= 10)
      bar.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`
      // The server expires the invitation; this only stops the clock so the UI
      // does not count into negative numbers while the message is in flight.
      if (remaining <= 0) this.stopCountdown()
    }
    tick()
    this.countdownTimer = setInterval(tick, 1000)
  }

  stopCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
  }

  // ── Analytics and events ─────────────────────────────────────────────────

  track(name: string, props?: Record<string, unknown>): void {
    const body = JSON.stringify([
      { name, visitorId: this.visitorId, pageUrl: location.href, props: props ?? null }
    ])
    const url = `${this.baseUrl}/api/events?siteId=${encodeURIComponent(this.options.siteId)}`
    // keepalive so an event fired during navigation still lands, and never
    // awaited so measurement is not on any path the visitor is waiting on.
    void fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      credentials: 'omit'
    }).catch(() => {})
  }

  emit(name: string, detail: Record<string, unknown> = {}): void {
    window.dispatchEvent(new CustomEvent(`founderlive:${name}`, { detail: { siteId: this.options.siteId, ...detail } }))
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /**
   * The name in the copy. Per site, never the host's own display name: a site
   * that has not chosen a label says "Agent is live", not "Dana is live".
   */
  name(): string {
    return this.config?.site.agentLabel || 'Agent'
  }

  statusOf(): PresenceView['status'] {
    return this.presence?.status ?? 'offline'
  }

  setView(view: View): void {
    this.clearJoinTimeout()
    if (this.view === view) return
    this.view = view
    this.formError = null
    this.busy = false
    if (view !== 'invited') this.stopCountdown()
    this.render()
  }

  private ensureMount(): ShadowRoot {
    if (this.root) return this.root

    const mount = document.createElement('founder-live')
    mount.setAttribute('data-position', this.options.position ?? this.config?.site.position ?? 'bottom-right')
    mount.setAttribute('data-theme', this.resolveTheme())

    const root = mount.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = WIDGET_STYLES
    root.append(style)

    const accent = this.options.accentColor ?? this.config?.site.accentColor
    if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) mount.style.setProperty('--fl-accent', accent)

    document.body.append(mount)
    this.mount = mount
    this.root = root
    return root
  }

  private resolveTheme(): 'dark' | 'light' {
    const preference = this.options.theme ?? this.config?.site.theme ?? 'auto'
    if (preference === 'dark' || preference === 'light') return preference
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  render(): void {
    if (this.destroyed) return
    const root = this.ensureMount()
    const container = root.querySelector('.fl-container') ?? el('div', { class: 'fl-container' })
    if (!container.parentNode) root.append(container)

    // During a call the panel is left alone. Every render rebuilds it, and an
    // iframe that is rebuilt — or even moved — reloads, which drops the media
    // session. Presence updates, queue changes and reconnect snapshots all
    // arrive mid-call and none of them change what the call view shows; only
    // a different call or an error state does.
    if (this.view === 'call' && this.call) {
      const key = `${this.call.callId}|${this.callErrored}|${this.iframeFallback}`
      if (key === this.callRenderKey && container.querySelector('.call-frame')) return
      this.callRenderKey = key
    } else {
      this.callRenderKey = null
    }

    this.mount?.setAttribute(
      'data-mode',
      this.view === 'call' ? 'call' : this.view === 'collapsed' ? 'collapsed' : 'panel'
    )

    if (this.view === 'collapsed') {
      // A site can choose to show nothing at all while the host is offline. The
      // socket stays open, so the bubble appears the moment they go live — no
      // reload, and no "offline" state ever shown on that site.
      const hiddenWhileOffline =
        this.config?.site.offlineMode === 'hide' && (this.presence?.status ?? 'offline') === 'offline'
      if (this.options.headless || hiddenWhileOffline) {
        replace(container)
        return
      }
      replace(container, renderBubble(this))
      return
    }
    replace(
      container,
      el('div', { class: 'scrim', on: { click: () => this.close() } }),
      renderPanel(this)
    )
  }
}

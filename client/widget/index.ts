/**
 * FounderLive — the embeddable widget.
 *
 *   <script src="https://live.example.com/widget.js" data-site="example"></script>
 *
 * Constraints this file is written against, all of them consequences of running
 * inside somebody else's page:
 *
 *   - One custom element with a shadow root. Nothing leaks out, nothing leaks in.
 *   - No framework, no runtime dependency, no `innerHTML` (see dom.ts).
 *   - The asset is static and cached for an hour; everything dynamic arrives over
 *     /embed/config and the socket, so presence can change in seconds while the
 *     script itself is never re-downloaded.
 *   - Camera and microphone are never touched here. They are requested inside the
 *     call iframe, at the moment the visitor joins, and not one step earlier.
 *
 * The public API (`FounderLive.init/open/close/destroy/getStatus`) and the
 * `founderlive:*` events exist so host applications can react — open the widget
 * from their own CTA, or track it in their own analytics.
 */

import type {
  HostProfileView,
  PresenceView,
  QueuePositionView,
  SelfView,
  ServerMessage
} from '../../src/shared/protocol'
import { clientMsg } from '../../src/shared/protocol'
import { COPY, bucketWait, withName } from '../../src/config'
import { ReconnectingSocket, commandId } from '../shared/socket'
import { WIDGET_STYLES } from './styles'
import { ICONS, el, icon, replace } from './dom'

// ─── Types ───────────────────────────────────────────────────────────────────

interface InitOptions {
  siteId: string
  position?: 'bottom-right' | 'bottom-left'
  theme?: 'dark' | 'light' | 'auto'
  accentColor?: string
  /** Suppresses the floating bubble; the host page opens the widget itself. */
  headless?: boolean
}

interface EmbedConfig {
  site: {
    id: string
    theme: 'dark' | 'light' | 'auto'
    position: 'bottom-right' | 'bottom-left'
    accentColor: string | null
    customGreeting: string | null
    /** 'hide' means render nothing at all while the host is offline. */
    offlineMode: 'show' | 'hide'
    /** The name in every line of copy. The server has already defaulted it. */
    agentLabel: string
  }
  host: HostProfileView
  presence: PresenceView
  wsUrl: string
  callUrl: string
}

type View =
  | 'collapsed'
  | 'live'
  | 'form'
  | 'waiting'
  | 'invited'
  | 'call'
  | 'ended'
  | 'offline_form'
  | 'offline_sent'

interface CallHandle {
  callId: string
  secret: string
}

const STORAGE_KEY = 'founderlive.visitorId'

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * A visitor identity is one browser, not one tab. Persisting it is what makes a
 * refresh keep its place in line and what stops two tabs becoming two people.
 *
 * Every access is guarded: Safari in Lock Down mode, private windows with site
 * data blocked, and embedded webviews all throw on `localStorage`. Losing the id
 * costs a place in line; throwing costs the whole widget.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore — the widget degrades to a per-tab identity */
  }
}

function visitorIdentity(): string {
  const existing = readStored(STORAGE_KEY)
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing
  const fresh =
    'v_' +
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  writeStored(STORAGE_KEY, fresh)
  return fresh
}

// ─── The widget ──────────────────────────────────────────────────────────────

class Widget {
  private readonly baseUrl: string
  private readonly options: InitOptions
  private readonly visitorId = visitorIdentity()

  private mount: HTMLElement | null = null
  private root: ShadowRoot | null = null
  /** The clip element is reused across renders; see renderClip. */
  private clipElement: HTMLElement | null = null
  private clipUrl: string | null = null

  private config: EmbedConfig | null = null
  private presence: PresenceView | null = null
  private profile: HostProfileView | null = null
  private self: SelfView | null = null
  private position: QueuePositionView | null = null
  private call: CallHandle | null = null
  private inviteExpiresAt: number | null = null
  /** Who is inviting us, when the server says. Falls back to the site label. */
  private inviteAgentName: string | null = null
  /** What the call view was last rendered for; see render(). */
  private callRenderKey: string | null = null

  private view: View = 'collapsed'
  private socket: ReconnectingSocket | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  private titleTimer: ReturnType<typeof setInterval> | null = null
  private joinTimeout: ReturnType<typeof setTimeout> | null = null
  private originalTitle = ''
  private clipMuted = true
  private formError: string | null = null
  /**
   * What the visitor has typed so far.
   *
   * Kept outside the DOM because any render rebuilds the form — and renders are
   * driven by presence, which changes whenever anybody else joins or leaves. A
   * stranger joining the queue must not wipe what someone is halfway through
   * typing.
   */
  private draft = { firstName: '', email: '', question: '' }
  private busy = false
  private destroyed = false
  /** Audio may only be played after the visitor has interacted with the page. */
  private interacted = false
  private iframeFallback = false
  /** The call surface reported a failure, so the panel's close control comes back. */
  private callErrored = false

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
    this.stopTitleFlash()
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pageshow', this.onVisibility)
    window.removeEventListener('message', this.onCallMessage)
    this.mount?.remove()
    this.mount = null
    this.root = null
    this.clipElement = null
    this.clipUrl = null
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
  private dismiss(): void {
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
    this.interacted = true
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      this.stopTitleFlash()
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

  private send(message: ReturnType<typeof clientMsg>): boolean {
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
        this.alertVisitor()
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

  private startJoinTimeout(): void {
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

  private setView(view: View): void {
    this.clearJoinTimeout()
    if (this.view === view) return
    this.view = view
    this.formError = null
    this.busy = false
    if (view !== 'invited') this.stopCountdown()
    this.render()
  }

  // ── Attention ────────────────────────────────────────────────────────────

  /**
   * "Your turn" has to be noticeable in a background tab without being obnoxious
   * or falling foul of autoplay and notification policy. Three channels, each
   * used only when it is actually permitted.
   */
  private alertVisitor(): void {
    if (document.visibilityState !== 'visible') {
      this.startTitleFlash()
      // Only if the visitor already granted it. Asking at this moment would put
      // a permission prompt between them and the call.
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const name = this.name()
          new Notification(`${name} is ready for you`, { body: "It's your turn — join the call.", tag: 'founderlive' })
        } catch {
          /* some browsers require a service worker; the title flash still works */
        }
      }
    }
    if (this.interacted) this.playChime()
  }

  /** A short, quiet two-tone chime, synthesised so the widget ships no audio asset. */
  private playChime(): void {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = new Ctor()
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55)
      gain.connect(ctx.destination)

      for (const [frequency, at] of [[660, 0], [880, 0.16]] as const) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = frequency
        osc.connect(gain)
        osc.start(ctx.currentTime + at)
        osc.stop(ctx.currentTime + at + 0.3)
      }
      setTimeout(() => void ctx.close().catch(() => {}), 900)
    } catch {
      /* audio is a nicety, never a requirement */
    }
  }

  private startTitleFlash(): void {
    if (this.titleTimer) return
    this.originalTitle = document.title
    let on = false
    this.titleTimer = setInterval(() => {
      on = !on
      document.title = on ? `🔔 Your turn — ${this.name()}` : this.originalTitle
    }, 1200)
  }

  private stopTitleFlash(): void {
    if (!this.titleTimer) return
    clearInterval(this.titleTimer)
    this.titleTimer = null
    if (this.originalTitle) document.title = this.originalTitle
  }

  // ── Analytics and events ─────────────────────────────────────────────────

  private track(name: string, props?: Record<string, unknown>): void {
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

  private emit(name: string, detail: Record<string, unknown> = {}): void {
    window.dispatchEvent(new CustomEvent(`founderlive:${name}`, { detail: { siteId: this.options.siteId, ...detail } }))
  }

  // ── Rendering ────────────────────────────────────────────────────────────

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

  private render(): void {
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
      replace(container, this.renderBubble())
      return
    }
    replace(
      container,
      el('div', { class: 'scrim', on: { click: () => this.close() } }),
      this.renderPanel()
    )
  }

  /**
   * The name in the copy. Per site, never the host's own display name: a site
   * that has not chosen a label says "Agent is live", not "Dana is live".
   */
  private name(): string {
    return this.config?.site.agentLabel || 'Agent'
  }

  private statusOf(): PresenceView['status'] {
    return this.presence?.status ?? 'offline'
  }

  private renderBubble(): HTMLElement {
    const status = this.statusOf()
    const waiting = this.presence?.queueLength ?? 0

    let label: string
    if (status === 'offline') label = withName(COPY.offlineHeadline, this.name())
    else if (status === 'busy' || status === 'paused') label = `${this.name()} is live`
    else label = withName(COPY.liveCta, this.name())

    return el('button', {
      class: 'bubble',
      attrs: {
        type: 'button',
        'aria-label': status === 'offline' ? `${this.name()} is offline — leave a question` : label,
        'aria-haspopup': 'dialog'
      },
      on: { click: () => this.open() },
      children: [
        this.renderAvatar(),
        el('span', { class: `dot ${status}`, attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'label', text: label }),
        status === 'busy' && waiting > 0
          ? el('span', { class: 'count', text: `· ${waiting} waiting` })
          : null
      ]
    })
  }

  private renderAvatar(): HTMLElement {
    const url = this.profile?.avatarUrl
    if (url) {
      return el('img', {
        class: 'avatar',
        attrs: { src: url, alt: '', width: 26, height: 26, loading: 'lazy', decoding: 'async' }
      })
    }
    return el('span', {
      class: 'avatar',
      attrs: { 'aria-hidden': 'true' },
      text: this.name().slice(0, 1).toUpperCase()
    })
  }

  private renderPanel(): HTMLElement {
    const body = el('div', { class: 'body' })

    const panel = el('div', {
      class: 'panel',
      attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': `Talk to ${this.name()}` },
      children: [
        // Shown only on phones (see .sheet-grab in styles). A thumb-sized target
        // at the top of the sheet, where a chevron is understood to mean "put
        // this away" — and during a call, to end it.
        el('button', {
          class: 'sheet-grab',
          attrs: {
            type: 'button',
            'aria-label': this.view === 'call' ? 'End call' : 'Close'
          },
          on: { click: () => this.dismiss() },
          children: [icon(ICONS.chevronDown, 24)]
        }),
        el('div', {
          class: 'panel-head',
          children: [
            el('span', { class: 'sr-only', text: `Talk to ${this.name()}` }),
            el('button', {
              class: 'close',
              attrs: { type: 'button', 'aria-label': 'Close' },
              on: { click: () => this.close() },
              children: [icon(ICONS.close, 16)]
            })
          ]
        }),
        body
      ]
    })

    switch (this.view) {
      case 'live':
        this.renderLive(body)
        break
      case 'form':
        this.renderForm(body)
        break
      case 'waiting':
        this.renderWaiting(body)
        break
      case 'invited':
        this.renderInvited(body)
        break
      case 'call':
        this.renderCall(body, panel)
        break
      case 'ended':
        this.renderEnded(body)
        break
      case 'offline_form':
        this.renderOfflineForm(body)
        break
      case 'offline_sent':
        this.renderOfflineSent(body)
        break
      default:
        break
    }

    // Escape closes, except during a call. Focus moves to the panel so keyboard
    // users are actually inside the thing that just opened.
    panel.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') this.close()
    })
    // Precedence matters: a single querySelector with a list returns whatever
    // comes first in the DOM, which is the close button. Focus belongs on the
    // thing the visitor came to do.
    queueMicrotask(() => {
      const target =
        panel.querySelector<HTMLElement>('input, textarea') ??
        panel.querySelector<HTMLElement>('.btn.primary') ??
        panel.querySelector<HTMLElement>('.btn')
      target?.focus({ preventScroll: true })
    })

    return panel
  }

  // ── STATE B: live panel ──────────────────────────────────────────────────

  private renderLive(body: HTMLElement): void {
    const status = this.statusOf()
    if (status === 'offline') {
      this.renderOfflineForm(body)
      return
    }

    const waiting = this.presence?.queueLength ?? 0
    const busy = status === 'busy'
    const paused = status === 'paused'

    const headline = withName(busy ? COPY.busyHeadline : COPY.liveHeadline, this.name())
    const text = paused ? withName(COPY.pausedBody, this.name()) : busy ? COPY.busyBody : COPY.liveBody

    const cta = el('button', {
      class: 'btn primary',
      attrs: { type: 'button', disabled: paused },
      text: withName(busy ? COPY.busyCta : COPY.liveCta, this.name()),
      on: {
        click: () => {
          this.track('talk_clicked')
          this.emit('talkclicked')
          this.setView('form')
          this.track('join_form_started')
        }
      }
    })

    replace(
      body,
      this.renderClip(),
      el('h2', { class: 'title', text: headline }),
      el('p', { class: 'text', text: this.config?.site.customGreeting ?? text }),
      busy && waiting > 0
        ? el('p', { class: 'text', children: [el('strong', { text: `${waiting} ${waiting === 1 ? 'person' : 'people'}` }), ' waiting.'] })
        : null,
      cta,
      el('p', { class: 'clip-note', text: COPY.clipNote })
    )
  }

  /**
   * The intro clip.
   *
   * Muted, inline, looping and autoplaying — the only combination browsers allow
   * without a gesture. The pill says "Live now" because the *person* is live; the
   * note underneath says the clip is an intro. Both are needed: the pill without
   * the note reads as a live camera feed, which it is not.
   */
  private renderClip(): HTMLElement {
    const loop = this.profile?.loopVideoUrl ?? null
    const poster = this.profile?.loopPosterUrl

    // Reused unless the clip itself changed. Rebuilding it meant a fresh <video>
    // on every presence update — so a stranger joining the queue re-downloaded
    // and restarted the clip on everyone else's phone.
    if (this.clipElement && this.clipUrl === loop) return this.clipElement

    const clip = el('div', { class: 'clip' })
    this.clipElement = clip
    this.clipUrl = loop

    if (loop) {
      const video = el('video', {
        attrs: {
          src: loop,
          poster: poster ?? undefined,
          autoplay: true,
          muted: true,
          playsinline: true,
          // Metadata only until it is on screen; the clip must not compete with
          // the host page's own loading.
          preload: 'metadata',
          'aria-label': `Intro clip from ${this.name()}`
        }
      }) as HTMLVideoElement
      video.muted = this.clipMuted
      // Some browsers ignore the attribute and honour only the property.
      video.playsInline = true
      // Looped by hand: a recording's audio and video tracks rarely end on the
      // same millisecond, and the native wrap-around restarts them from
      // different points, so the drift compounds on every pass. Seeking to zero
      // puts both tracks back together. Matters here because this clip loops for
      // as long as the panel is open.
      video.loop = false
      video.onended = () => {
        video.currentTime = 0
        void video.play().catch(() => {})
      }
      void video.play().catch(() => {
        // Autoplay refused (data saver, low power mode). The poster remains, which
        // is why one is worth uploading.
      })
      clip.append(video)

      // Toggled in place rather than through a re-render: rebuilding the panel
      // recreates the <video> and restarts the clip from zero, so unmuting would
      // throw away whatever the visitor was in the middle of watching.
      const soundButton = el('button', {
        class: 'clip-sound',
        attrs: { type: 'button', 'aria-label': 'Unmute intro clip', 'aria-pressed': 'false' }
      })
      const syncSound = () => {
        video.muted = this.clipMuted
        replace(soundButton, icon(this.clipMuted ? ICONS.soundOff : ICONS.soundOn, 15))
        soundButton.setAttribute('aria-label', this.clipMuted ? 'Unmute intro clip' : 'Mute intro clip')
        soundButton.setAttribute('aria-pressed', String(!this.clipMuted))
      }
      soundButton.addEventListener('click', () => {
        this.clipMuted = !this.clipMuted
        syncSound()
        if (!this.clipMuted) void video.play().catch(() => {})
      })
      syncSound()
      clip.append(soundButton)
    } else if (poster) {
      clip.append(el('img', { attrs: { src: poster, alt: `${this.name()}`, loading: 'lazy', decoding: 'async' } }))
    } else {
      // No clip uploaded yet. A designed empty state, not a broken <video>.
      clip.append(
        el('div', {
          class: 'fallback',
          children: [this.renderAvatar(), el('span', { text: `${this.name()} is here right now` })]
        })
      )
    }

    clip.append(
      el('span', {
        class: 'clip-pill',
        children: [el('span', { class: 'dot available', attrs: { 'aria-hidden': 'true' } }), COPY.livePill]
      })
    )
    return clip
  }

  // ── STATE C: join form ───────────────────────────────────────────────────

  private renderForm(body: HTMLElement): void {
    const name = el('input', {
      attrs: { id: 'fl-name', type: 'text', required: true, maxlength: 40, autocomplete: 'given-name', placeholder: 'Sarah' },
      on: { input: (event) => { this.draft.firstName = (event.target as HTMLInputElement).value } }
    })
    const email = el('input', {
      attrs: { id: 'fl-email', type: 'email', maxlength: 120, autocomplete: 'email', placeholder: 'you@company.com' },
      on: { input: (event) => { this.draft.email = (event.target as HTMLInputElement).value } }
    })
    const question = el('textarea', {
      attrs: { id: 'fl-question', maxlength: 500, placeholder: 'What do you want to talk about?' },
      on: { input: (event) => { this.draft.question = (event.target as HTMLTextAreaElement).value } }
    })
    name.value = this.draft.firstName
    email.value = this.draft.email
    question.value = this.draft.question

    const submit = el('button', {
      class: 'btn primary',
      attrs: { type: 'submit', disabled: this.busy },
      text: this.busy ? 'Joining…' : 'Join the line'
    })

    const form = el('form', {
      class: 'form',
      attrs: { novalidate: true },
      on: {
        submit: (event) => {
          event.preventDefault()
          const firstName = name.value.trim()
          if (!firstName) {
            this.formError = 'Please add your first name.'
            this.render()
            return
          }
          this.busy = true
          const sent = this.send(
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
            this.busy = false
            this.formError = 'Connection lost — try again in a moment.'
            this.render()
            return
          }
          // A socket can report OPEN and still be a black hole (a suspended tab,
          // a proxy that dropped the connection silently). Without this the
          // button has no way back and the visitor just leaves.
          this.startJoinTimeout()
          this.render()
          this.emit('queuejoined', {})
        }
      },
      children: [
        el('h2', { class: 'title', text: withName(COPY.joinTitle, this.name()) }),
        el('div', { children: [el('label', { attrs: { for: 'fl-name' }, text: 'Your name *' }), name] }),
        el('div', { children: [el('label', { attrs: { for: 'fl-email' }, text: 'Email (optional)' }), email] }),
        el('div', {
          children: [el('label', { attrs: { for: 'fl-question' }, text: 'What do you want to talk about?' }), question]
        }),
        this.formError ? el('p', { class: 'field-error', attrs: { role: 'alert' }, text: this.formError }) : null,
        submit,
        el('p', { class: 'consent', text: withName(COPY.joinConsent, this.name()) }),
        el('button', {
          class: 'btn quiet',
          attrs: { type: 'button' },
          text: 'Back',
          on: { click: () => this.setView('live') }
        })
      ]
    })

    replace(body, form)
  }

  // ── STATE D: waiting ─────────────────────────────────────────────────────

  private renderWaiting(body: HTMLElement): void {
    const position = this.position
    const ahead = position?.peopleAhead ?? 0
    const estimate = position?.estimatedWaitSeconds ?? null

    replace(
      body,
      el('h2', { class: 'title', text: "You're in line" }),
      el('div', {
        class: 'position',
        children: [
          el('span', { class: 'n', text: `#${position?.position ?? 1}` }),
          el('span', {
            class: 'eta',
            text: ahead === 0 ? "You're next" : `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you`
          })
        ]
      }),
      // No estimate until there is enough history to make an honest one. A number
      // invented from two data points is worse than no number.
      estimate !== null
        ? el('p', { class: 'text', text: `Approximate wait: ${bucketWait(estimate)}` })
        : null,
      el('p', { class: 'hint', text: `Keep this tab open — I'll let you know when ${this.name()} is ready.` }),
      el('button', {
        class: 'btn quiet',
        attrs: { type: 'button' },
        text: 'Leave the line',
        on: {
          click: () => {
            this.send(clientMsg('QUEUE_LEAVE', { commandId: commandId() }))
            this.position = null
            this.setView('live')
            this.emit('queueleft', {})
          }
        }
      })
    )
  }

  // ── Your turn ────────────────────────────────────────────────────────────

  private renderInvited(body: HTMLElement): void {
    const total = Math.max(1, Math.round(((this.inviteExpiresAt ?? Date.now()) - Date.now()) / 1000))
    const countdown = el('span', { class: 'countdown', text: formatClock(total) })
    const bar = el('i')

    replace(
      body,
      el('div', {
        class: 'ready',
        children: [
          el('div', {
            class: 'row',
            children: [
              el('span', { class: 'dot available', attrs: { 'aria-hidden': 'true' } }),
              el('h2', { class: 'title', text: withName(COPY.invitedTitle, this.inviteAgentName ?? this.name()) })
            ]
          }),
          el('p', { class: 'text', text: COPY.invitedBody }),
          el('div', { class: 'ring', children: [bar] }),
          countdown
        ]
      }),
      el('button', {
        class: 'btn primary',
        attrs: { type: 'button' },
        text: 'Join video call',
        on: {
          click: () => {
            this.send(clientMsg('VISITOR_ACCEPT_INVITE', { commandId: commandId() }))
            this.stopTitleFlash()
          }
        }
      }),
      el('button', {
        class: 'btn quiet',
        attrs: { type: 'button' },
        text: 'Not now',
        on: {
          click: () => {
            this.send(clientMsg('VISITOR_DECLINE_INVITE', { commandId: commandId() }))
            this.setView('live')
          }
        }
      })
    )

    this.startCountdown(countdown, bar, total)
  }

  private startCountdown(label: HTMLElement, bar: HTMLElement, total: number): void {
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

  private stopCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
  }

  // ── In call ──────────────────────────────────────────────────────────────

  /**
   * The call runs in a same-origin iframe.
   *
   * That single decision is what lets the conversation happen without the visitor
   * leaving the page, while keeping the WebRTC SDK, the media permissions and all
   * of the call's CSS inside our own origin rather than injected into a customer's
   * site. `allow` is what grants the frame camera and microphone; without it the
   * browser refuses regardless of what the visitor clicks.
   */
  private renderCall(body: HTMLElement, panel: HTMLElement): void {
    const call = this.call
    if (!call) {
      this.setView('live')
      return
    }

    const url = new URL(`${this.config?.callUrl ?? `${this.baseUrl}/call`}`)
    url.searchParams.set('callId', call.callId)
    url.searchParams.set('secret', call.secret)
    url.searchParams.set('who', 'visitor')
    url.searchParams.set('visitorId', this.visitorId)
    url.searchParams.set('name', this.inviteAgentName ?? this.name())
    // Lets the call page set frame-ancestors and its postMessage target to this
    // exact origin instead of a wildcard — validated server-side against the
    // site's allow-list, so claiming someone else's origin achieves nothing.
    url.searchParams.set('siteId', this.options.siteId)
    url.searchParams.set('origin', location.origin)

    const frame = el('iframe', {
      class: 'call-frame',
      attrs: {
        src: url.toString(),
        allow: 'camera; microphone; autoplay; fullscreen',
        title: `Video call with ${this.name()}`
      }
    })

    replace(body, frame)
    // Hidden during a healthy call so a stray click cannot hang up on someone —
    // but restored the moment the call surface says it failed, or there is no
    // way out of the error screen.
    panel.querySelector('.panel-head')?.classList.toggle('hidden', !this.callErrored)

    if (this.iframeFallback) {
      // Rendered outside the frame, because if the frame cannot get permissions
      // it cannot show the way out of that either.
      body.append(
        el('div', {
          class: 'form',
          attrs: { style: 'padding:14px' },
          children: [
            el('p', { class: 'text', text: 'Your browser blocked the camera inside this page.' }),
            el('a', {
              class: 'btn primary',
              attrs: { href: url.toString(), target: '_blank', rel: 'noopener' },
              text: 'Open the call in a new tab'
            })
          ]
        })
      )
    }
  }

  private onCallMessage = (event: MessageEvent): void => {
    // Only our own call page may drive this. Anything else on the page can post
    // messages too, so both the origin and the envelope are checked.
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

  private renderEnded(body: HTMLElement): void {
    this.iframeFallback = false
    this.callErrored = false
    replace(
      body,
      el('h2', { class: 'title', text: withName(COPY.endedTitle, this.name()) }),
      el('p', { class: 'text', text: 'Thanks for the conversation.' }),
      el('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Close', on: { click: () => this.close() } })
    )
  }

  // ── Offline ──────────────────────────────────────────────────────────────

  private renderOfflineForm(body: HTMLElement): void {
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
            this.formError = 'Add your name and a message.'
            this.render()
            return
          }
          this.busy = true
          this.render()
          try {
            const response = await fetch(
              `${this.baseUrl}/api/offline-message?siteId=${encodeURIComponent(this.options.siteId)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'omit',
                body: JSON.stringify({
                  visitorId: this.visitorId,
                  name: name.value.trim(),
                  email: email.value.trim() || null,
                  message: message.value.trim(),
                  pageUrl: location.href
                })
              }
            )
            if (!response.ok) throw new Error(String(response.status))
            this.setView('offline_sent')
            this.emit('offlinemessagesent', {})
          } catch {
            this.busy = false
            this.formError = 'That did not send. Try again in a moment.'
            this.render()
          }
        }
      },
      children: [
        el('h2', { class: 'title', text: withName(COPY.offlineHeadline, this.name()) }),
        el('p', { class: 'text', text: withName(COPY.offlineBody, this.name()) }),
        el('div', { children: [el('label', { attrs: { for: 'fl-off-name' }, text: 'Your name *' }), name] }),
        el('div', { children: [el('label', { attrs: { for: 'fl-off-email' }, text: 'Email' }), email] }),
        el('div', { children: [el('label', { attrs: { for: 'fl-off-message' }, text: 'Message *' }), message] }),
        this.formError ? el('p', { class: 'field-error', attrs: { role: 'alert' }, text: this.formError }) : null,
        el('button', {
          class: 'btn primary',
          attrs: { type: 'submit', disabled: this.busy },
          text: this.busy ? 'Sending…' : 'Send'
        })
      ]
    })

    replace(body, form)
  }

  private renderOfflineSent(body: HTMLElement): void {
    replace(
      body,
      el('h2', { class: 'title', text: 'Got it.' }),
      el('p', { class: 'text', text: `${this.name()} will come back to you.` }),
      el('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Close', on: { click: () => this.close() } })
    )
  }
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.max(0, seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * The base URL is read from this script's own `src` rather than configured,
 * which is what keeps widget.js completely static and therefore cacheable for an
 * hour: there is nothing deployment-specific inside it.
 */
function resolveBaseUrl(): string {
  const current = document.currentScript as HTMLScriptElement | null
  const src = current?.src ?? findWidgetScript()?.src
  if (!src) return location.origin
  try {
    return new URL(src).origin
  } catch {
    return location.origin
  }
}

function findWidgetScript(): HTMLScriptElement | null {
  const scripts = Array.from(document.getElementsByTagName('script'))
  return scripts.find((script) => /\/widget(\/v\d+)?\.js/.test(script.src)) ?? null
}

let instance: Widget | null = null

const api = {
  init(options: InitOptions): void {
    if (instance) return
    if (!options?.siteId) return
    instance = new Widget(resolveBaseUrl(), options)
    void instance.start()
  },
  open(): void {
    instance?.open()
  },
  close(): void {
    instance?.close()
  },
  destroy(): void {
    instance?.destroy()
    instance = null
  },
  getStatus() {
    return instance?.status() ?? null
  }
}

declare global {
  interface Window {
    FounderLive?: typeof api
  }
}

window.FounderLive = api

// Auto-initialise from the script tag's data attributes, so the common case is
// one line of HTML and no JavaScript at all.
const tag = (document.currentScript as HTMLScriptElement | null) ?? findWidgetScript()
const siteId = tag?.dataset.site
if (siteId) {
  const boot = () =>
    api.init({
      siteId,
      position: tag?.dataset.position as InitOptions['position'],
      theme: tag?.dataset.theme as InitOptions['theme'],
      accentColor: tag?.dataset.accent
    })
  // `document.body` must exist before anything is mounted, and a widget must
  // never be the reason a page's own load event is late.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
}

export {}

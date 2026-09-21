/** The widget's public options, what /embed/config returns, and the screens it can show. */

import type { HostProfileView, PresenceView } from '../../src/shared/protocol'

export interface InitOptions {
  siteId: string
  position?: 'bottom-right' | 'bottom-left'
  theme?: 'dark' | 'light' | 'auto'
  accentColor?: string
  /** Suppresses the floating bubble; the host page opens the widget itself. */
  headless?: boolean
}

export interface EmbedConfig {
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

export type View =
  | 'collapsed'
  | 'live'
  | 'form'
  | 'waiting'
  | 'invited'
  | 'call'
  | 'ended'
  | 'offline_form'
  | 'offline_sent'

export interface CallHandle {
  callId: string
  secret: string
}

/** What the visitor has typed into the join form so far. */
export interface Draft {
  firstName: string
  email: string
  question: string
}

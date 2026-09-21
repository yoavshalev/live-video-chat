/** Worker bindings, environment variables and D1 row shapes. */

import type { LiveHostRoom } from './durable/LiveHostRoom'
import type { AgentSession } from './lib/auth'
import type { AgentRole } from './shared/protocol'

export interface Env {
  // Bindings
  LIVE_HOST_ROOM: DurableObjectNamespace<LiveHostRoom>
  DB: D1Database
  RATE: KVNamespace
  MEDIA: R2Bucket

  // Vars (wrangler.jsonc)
  /**
   * One deployment is one organization. This is the Durable Object's name and
   * the hosts.id row that holds the organization's intro clip. Agents are rows
   * in the agents table; there can be any number of them.
   */
  ORG_ID: string
  /** Optional. Unset, the origin each request arrived on; see lib/base-url.ts. */
  PUBLIC_BASE_URL?: string
  HOST_AUTH_MODE: 'password' | 'access'
  REALTIMEKIT_HOST_PRESET: string
  REALTIMEKIT_VISITOR_PRESET: string

  // Secrets (wrangler secret put) — all optional at the type level because the
  // Worker has to boot and serve a useful error when one is missing, rather than
  // throwing on module load and returning a blank 500.
  CLOUDFLARE_ACCOUNT_ID?: string
  REALTIMEKIT_APP_ID?: string
  REALTIMEKIT_API_TOKEN?: string
  SESSION_SECRET?: string
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  /** Access mode only. Optional comma-separated allow-list on top of the Access policy. */
  ALLOWED_HOST_EMAIL?: string
}

export interface AppVariables {
  /** Set by the agent auth middleware; null on every public route. */
  agent: AgentSession | null
}

export type AppEnv = { Bindings: Env; Variables: AppVariables }

// ─── D1 rows ─────────────────────────────────────────────────────────────────

export interface SiteRow {
  id: string
  name: string
  /** Legacy: JSON array of exact origins. Read only when allowed_domains is empty. */
  allowed_origins: string
  /** JSON array of root domains, e.g. ["example.com","localhost"]. See src/shared/domains.ts. */
  allowed_domains: string
  theme: 'dark' | 'light' | 'auto'
  position: 'bottom-right' | 'bottom-left'
  accent_color: string | null
  custom_greeting: string | null
  enabled: number
  created_at: number
  /** 'show' renders the offline state; 'hide' renders nothing while offline. */
  offline_mode: 'show' | 'hide'
  /** Name used in the widget copy for this site. NULL → "Agent". */
  agent_label: string | null
}

/** One row per organization (id = ORG_ID): the intro clip and its wording. */
export interface HostRow {
  id: string
  display_name: string
  headline: string
  subheadline: string
  loop_video_url: string | null
  loop_poster_url: string | null
  avatar_url: string | null
  created_at: number
  updated_at: number
}

export interface AgentRow {
  id: string
  name: string
  email: string
  /** NULL in Cloudflare Access mode. Otherwise "pbkdf2$…" — see src/lib/password.ts. */
  password_hash: string | null
  role: AgentRole
  /** 0 or 1. A disabled agent cannot sign in and is signed out on their next request. */
  enabled: number
  created_at: number
  last_login_at: number | null
}

export interface CallRow {
  id: string
  visitor_id: string
  site_id: string
  queue_session_id: string
  /** NULL on rows from before agents existed. */
  agent_id: string | null
  realtime_room_id: string | null
  started_at: number
  ended_at: number | null
  duration_seconds: number | null
  disconnect_reason: string | null
}

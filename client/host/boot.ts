/** What the server handed the dashboard at render time (src/routes/host/page.ts). */

export interface Site {
  id: string
  name: string
  allowedDomains: string[]
  position: 'bottom-right' | 'bottom-left'
  enabled: boolean
  offlineMode: 'show' | 'hide'
  agentLabel: string | null
}

export interface AgentSummary {
  id: string
  name: string
  email: string
  role: 'admin' | 'agent'
  enabled: boolean
  hasPassword: boolean
  createdAt: number
  lastLoginAt: number | null
}

export interface InboxItem {
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

export interface Boot {
  baseUrl: string
  orgId: string
  orgName: string
  authMode: 'password' | 'access'
  me: { agentId: string; name: string; email: string; role: 'admin' | 'agent' }
  wsUrl: string
  sites: Site[]
  agents: AgentSummary[]
}

export const boot = JSON.parse(document.getElementById('boot')?.textContent ?? '{}') as Boot
export const isAdmin = boot.me?.role === 'admin'

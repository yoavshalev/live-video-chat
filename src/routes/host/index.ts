/**
 * Everything under /host and /api/host, in one register() so src/index.ts
 * mounts the dashboard with a single call. Each part is its own file:
 *
 *   login.ts   sign in / out, the client bundle
 *   reads.ts   metrics, activity, inbox, diagnostics
 *   sites.ts   site management
 *   agents.ts  agent management, your own password
 *   page.ts    the dashboard itself, assembled from tabs/
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../types'
import { registerLogin } from './login'
import { registerReads } from './reads'
import { registerSites } from './sites'
import { registerAgents } from './agents'
import { registerDashboard } from './page'

export function register(app: Hono<AppEnv>): void {
  registerLogin(app)
  registerReads(app)
  registerSites(app)
  registerAgents(app)
  registerDashboard(app)
  app.get('/', (c) => c.redirect('/host'))
}

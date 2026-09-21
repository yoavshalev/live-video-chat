/**
 * Site management and domain enforcement, end to end.
 *
 *   node scripts/smoke-sites.mjs [baseUrl] [password] [email] [--disruptive]
 *
 * The unit suite (test/domains.test.ts) proves the matcher is right. This proves
 * the matcher is actually what the Worker consults: a subdomain gets in, a
 * lookalike does not, a disabled site refuses its own domain, and every
 * dashboard mutation — create, add/remove domain, wording, offline mode — round
 * trips through D1 and the per-isolate cache.
 *
 * It creates a throwaway site (`zz-apitest-…`) and leaves it DISABLED with no
 * domains, because there is no delete endpoint. Harmless, but it is a write, so
 * like the other suites this refuses a non-localhost target without --disruptive.
 */

import { setDefaultResultOrder } from 'node:dns'

// See scripts/smoke.mjs for why.
setDefaultResultOrder('ipv4first')

const BASE = process.argv[2] ?? 'http://localhost:8787'
const PASSWORD = process.argv[3] ?? 'local-dev-password'
const EMAIL = process.argv[4] ?? 'dev@example.com'

let fails = 0
let n = 0
function check(label, condition, detail = '') {
  n += 1
  if (!condition) fails += 1
  console.log(`${condition ? ' ok ' : 'FAIL'}  ${String(n).padStart(2)}. ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE)
if (!isLocal && !process.argv.includes('--disruptive')) {
  console.log(`Refusing to run against ${BASE}: this suite creates a site. Re-run with --disruptive.\n`)
  process.exit(2)
}

console.log(`\nSite management test → ${BASE}\n`)

const login = await fetch(`${BASE}/host/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email: EMAIL, password: PASSWORD, next: '/host' }),
  redirect: 'manual'
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
check('signed in as the host', cookie.startsWith('fl_agent='))
if (!cookie.startsWith('fl_agent=')) {
  console.log('\nCould not sign in — wrong password, or the login rate limit is exhausted.\n')
  process.exit(1)
}
const H = { 'Content-Type': 'application/json', Cookie: cookie }
const json = async (r) => {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t } }
}
const config = (site, origin) => fetch(`${BASE}/embed/config?siteId=${site}`, { headers: { Origin: origin } })
const status = async (site, origin) => (await config(site, origin)).status

// ── A seeded site, and the matcher behind it ────────────────────────────────
const list = await json(await fetch(`${BASE}/api/host/sites`, { headers: H }))
const site = list.sites?.find((s) => s.enabled && s.allowedDomains?.some((d) => d !== 'localhost'))
check('at least one enabled site with a real domain exists', Boolean(site), JSON.stringify(list).slice(0, 120))
if (!site) process.exit(1)
const root = site.allowedDomains.find((d) => d !== 'localhost')
console.log(`       using site "${site.id}" with root ${root}`)

check('the apex is admitted', (await status(site.id, `https://${root}`)) === 200)
check('a subdomain is admitted', (await status(site.id, `https://app.${root}`)) === 200)
check('a lookalike is refused', (await status(site.id, `https://evil-${root}`)) === 403)
check('the domain as a prefix of another host is refused', (await status(site.id, `https://${root}.attacker.net`)) === 403)
check('plain http on the real domain is refused', (await status(site.id, `http://${root}`)) === 403)
const conf = await json(await config(site.id, `https://${root}`))
check('config carries offlineMode and an agentLabel', ['show', 'hide'].includes(conf.site?.offlineMode) && typeof conf.site?.agentLabel === 'string', JSON.stringify(conf.site))

// ── Lifecycle of a throwaway site ───────────────────────────────────────────
const id = `zz-apitest-${Math.random().toString(36).slice(2, 7)}`
const created = await json(await fetch(`${BASE}/api/host/sites`, { method: 'POST', headers: H, body: JSON.stringify({ id, name: 'API Test' }) }))
check('create a site', created.site?.id === id, JSON.stringify(created))
check('a new site admits nothing', (await status(id, 'https://apitest.example')) === 403)
check('a registry suffix is refused as a domain', (await fetch(`${BASE}/api/host/sites/${id}/domains`, { method: 'POST', headers: H, body: JSON.stringify({ domain: 'co.uk' }) })).status === 400)
check('garbage is refused as a domain', (await fetch(`${BASE}/api/host/sites/${id}/domains`, { method: 'POST', headers: H, body: JSON.stringify({ domain: 'not a domain' }) })).status === 400)

const added = await json(await fetch(`${BASE}/api/host/sites/${id}/domains`, { method: 'POST', headers: H, body: JSON.stringify({ domain: 'https://www.ApiTest.Example/pricing' }) }))
check('a pasted URL is normalised to its root', added.site?.allowedDomains?.[0] === 'apitest.example', JSON.stringify(added.site?.allowedDomains))
check('the new domain admits its apex', (await status(id, 'https://apitest.example')) === 200)
check('the new domain admits a subdomain', (await status(id, 'https://shop.apitest.example')) === 200)
const dup = await json(await fetch(`${BASE}/api/host/sites/${id}/domains`, { method: 'POST', headers: H, body: JSON.stringify({ domain: 'apitest.example' }) }))
check('adding a domain twice is idempotent', dup.site?.allowedDomains?.length === 1)

// ── Settings ────────────────────────────────────────────────────────────────
let r = await json(await fetch(`${BASE}/api/host/sites/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ agentLabel: ' <b>Sales</b> team ', offlineMode: 'hide' }) }))
check('PATCH sets a sanitised label and the offline mode', r.site?.agentLabel === 'Sales team' && r.site?.offlineMode === 'hide', JSON.stringify(r))
const conf2 = await json(await config(id, 'https://apitest.example'))
check('config reflects the settings', conf2.site?.agentLabel === 'Sales team' && conf2.site?.offlineMode === 'hide', JSON.stringify(conf2.site))
r = await json(await fetch(`${BASE}/api/host/sites/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ agentLabel: '', offlineMode: 'show' }) }))
check('an empty label clears back to the default', r.site?.agentLabel === null && r.site?.offlineMode === 'show')
check('a bad offlineMode is a 400', (await fetch(`${BASE}/api/host/sites/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ offlineMode: 'sometimes' }) })).status === 400)

// ── Disable, remove, tear down ──────────────────────────────────────────────
const off = await json(await fetch(`${BASE}/api/host/sites/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }) }))
check('disable the site', off.site?.enabled === false)
check('a disabled site refuses its own domain', (await status(id, 'https://apitest.example')) === 403)
const removed = await json(await fetch(`${BASE}/api/host/sites/${id}/domains/${encodeURIComponent('apitest.example')}`, { method: 'DELETE', headers: H }))
check('remove the domain', removed.site?.allowedDomains?.length === 0)
check('site management requires the host session', (await fetch(`${BASE}/api/host/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x-anon', name: 'x' }) })).status === 401)
check('a duplicate site id is a 409', (await fetch(`${BASE}/api/host/sites`, { method: 'POST', headers: H, body: JSON.stringify({ id, name: 'again' }) })).status === 409)
const inbox = await json(await fetch(`${BASE}/api/host/inbox`, { headers: H }))
check('the inbox answers with a list', Array.isArray(inbox.items))

console.log(`\n${fails === 0 ? 'All site checks passed.' : `${fails} check(s) failed.`}\n`)
process.exit(fails ? 1 : 0)

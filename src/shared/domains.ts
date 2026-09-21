/**
 * Domain matching for the embed allow-list.
 *
 * A site is configured with ROOT DOMAINS rather than exact origins, and each
 * root covers itself plus any subdomain: `example.com` admits `example.com`,
 * `www.example.com` and `app.example.com`.
 *
 * THIS IS A SECURITY BOUNDARY. `siteId` arrives from a script tag on a page we
 * do not control, so the browser-supplied `Origin` header is the only thing that
 * makes it meaningful. Suffix matching is the classic place to get that wrong,
 * in two specific ways this file exists to prevent:
 *
 *   1. Naive `endsWith(domain)` admits `evil-example.com` and
 *      `notexample.com`. The check here is `endsWith('.' + domain)`, so a
 *      subdomain boundary is always required.
 *
 *   2. `endsWith('.' + domain)` still admits `example.com.attacker.net` if you
 *      compare against the wrong end — hence matching on the parsed `hostname`,
 *      never on the raw string.
 *
 * Both cases are covered by tests in test/domains.test.ts.
 */

/**
 * Registry suffixes that must never be accepted as a root domain.
 *
 * `co.uk` has two labels, so the "at least two labels" rule below does not catch
 * it — and accepting it would admit every site in the United Kingdom. Not a
 * complete public suffix list (that is thousands of entries and changes
 * monthly); it covers the ones somebody might plausibly type by accident.
 */
const REGISTRY_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.br', 'net.br', 'org.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.in', 'net.in', 'org.in',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.cn', 'com.tw',
  'co.kr', 'com.pl', 'com.es', 'com.pt', 'com.ua', 'com.ru'
])

/**
 * Multi-tenant hosting suffixes. `github.io` is not a registry suffix, but it is
 * a root under which strangers get subdomains, so accepting it as a customer's
 * domain would admit every GitHub Pages site. A customer's own site under one of
 * these — `mysite.github.io` — is fine, and the subdomain rule covers its
 * subtree as usual. Not exhaustive; the Public Suffix List's private section
 * is the complete answer and far too large to ship here.
 */
const PLATFORM_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'r2.dev', 'trycloudflare.com',
  'vercel.app', 'netlify.app', 'herokuapp.com', 'fly.dev', 'onrender.com', 'railway.app', 'deno.dev',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'azurestaticapps.net',
  'cloudfront.net', 'amazonaws.com', 'ondigitalocean.app', 'linodeusercontent.com',
  'wixsite.com', 'myshopify.com', 'webflow.io', 'squarespace.com', 'weebly.com', 'wordpress.com',
  'blogspot.com', 'tumblr.com', 'godaddysites.com', 'hubspotpagebuilder.com', 'wpengine.com',
  'glitch.me', 'repl.co', 'replit.app', 'surge.sh', 'ngrok.io', 'ngrok.app', 'ngrok-free.app',
  'framer.app', 'framer.website', 'carrd.co', 'notion.site', 'super.site', 'bubbleapps.io', 'softr.app', 'lovable.app'
])

/** Hosts that may be reached over plain http, because there is no https on them. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Cleans up whatever the host typed into a root domain, or returns null if it is
 * not usable as one.
 *
 * Deliberately forgiving about input — a pasted URL, a trailing slash, a leading
 * `*.`, a `www.` prefix all reduce to the same root — and deliberately strict
 * about the result. `www.` is stripped because "the root domain" is what was
 * asked for and the www host is covered by the subdomain rule anyway; no other
 * label is stripped, so entering `app.example.com` scopes the site to that
 * subtree on purpose.
 */
export function normalizeDomain(input: string): string | null {
  let value = String(input ?? '').trim().toLowerCase()
  if (!value) return null

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      return null
    }
  }

  value = value
    .replace(/^\*\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')

  if (LOCAL_HOSTS.has(value)) return value
  value = value.replace(/^www\./, '')

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) return null
  if (value.length > 253) return null

  const labels = value.split('.')
  // A single label is either a typo or a bare TLD; both would be far too broad.
  if (labels.length < 2) return null
  if (labels.some((label) => label.length === 0 || label.length > 63)) return null
  if (REGISTRY_SUFFIXES.has(value) || PLATFORM_SUFFIXES.has(value)) return null

  return value
}

/** True when `origin` is covered by `domain` or any of its subdomains. */
export function originMatchesDomain(origin: string, domain: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const isLocal = LOCAL_HOSTS.has(host)

  // https only, with an exception for local development, which has no https.
  // Allowing http generally would let anything on a hijacked coffee-shop network
  // pass the check by serving a page over http on a matching hostname.
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return false

  const root = domain.toLowerCase()
  // The leading dot is the whole point: without it `evil-example.com` matches
  // `example.com`.
  return host === root || host.endsWith(`.${root}`)
}

export function originAllowed(origin: string, domains: readonly string[]): boolean {
  return domains.some((domain) => originMatchesDomain(origin, domain))
}

/** What the dashboard shows under a domain, so the subdomain rule is visible. */
export function describeDomain(domain: string): string {
  return LOCAL_HOSTS.has(domain) ? `${domain} (any port)` : `${domain} and any subdomain`
}

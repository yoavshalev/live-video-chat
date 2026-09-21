/**
 * Domain allow-list tests.
 *
 * This is the check that stands between the Worker and any stranger who wants to
 * embed the widget on their own traffic, so the interesting cases here are all
 * the ways a lookalike hostname tries to pass for a real one.
 */

import { describe, expect, it } from 'vitest'
import { describeDomain, normalizeDomain, originAllowed, originMatchesDomain } from '../src/shared/domains'

describe('normalizeDomain', () => {
  it('accepts a plain root domain', () => {
    expect(normalizeDomain('example.com')).toBe('example.com')
  })

  it('forgives the ways people actually type a domain', () => {
    expect(normalizeDomain('  Example.COM  ')).toBe('example.com')
    expect(normalizeDomain('https://example.com/pricing?x=1')).toBe('example.com')
    expect(normalizeDomain('example.com/')).toBe('example.com')
    expect(normalizeDomain('example.com:443')).toBe('example.com')
    expect(normalizeDomain('*.example.com')).toBe('example.com')
    expect(normalizeDomain('example.com.')).toBe('example.com')
  })

  it('reduces www to the root, since the root already covers it', () => {
    expect(normalizeDomain('www.example.com')).toBe('example.com')
    expect(normalizeDomain('https://www.example.com')).toBe('example.com')
  })

  it('keeps any other subdomain, so a site can be scoped to one subtree', () => {
    expect(normalizeDomain('app.example.com')).toBe('app.example.com')
    expect(normalizeDomain('staging.app.example.com')).toBe('staging.app.example.com')
  })

  it('refuses a bare TLD, which would open an entire registry', () => {
    expect(normalizeDomain('com')).toBeNull()
    expect(normalizeDomain('io')).toBeNull()
    expect(normalizeDomain('localhost.')).toBe('localhost')
  })

  it('refuses multi-label registry suffixes, which two labels alone would allow', () => {
    // This is the one the "at least two labels" rule does not catch, and it
    // would admit every site in the United Kingdom.
    expect(normalizeDomain('co.uk')).toBeNull()
    expect(normalizeDomain('com.au')).toBeNull()
    expect(normalizeDomain('co.il')).toBeNull()
    // A real domain under one of them is fine.
    expect(normalizeDomain('mysite.co.uk')).toBe('mysite.co.uk')
  })

  it('refuses multi-tenant hosting suffixes as roots, but not a site under one', () => {
    // github.io as a root would admit every GitHub Pages site in the world.
    expect(normalizeDomain('github.io')).toBeNull()
    expect(normalizeDomain('pages.dev')).toBeNull()
    expect(normalizeDomain('https://vercel.app/')).toBeNull()
    expect(normalizeDomain('mysite.github.io')).toBe('mysite.github.io')
    expect(normalizeDomain('shop.myshopify.com')).toBe('shop.myshopify.com')
  })

  it('refuses malformed input', () => {
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('   ')).toBeNull()
    expect(normalizeDomain('exa mple.com')).toBeNull()
    expect(normalizeDomain('example..com')).toBeNull()
    expect(normalizeDomain('-example.com')).toBeNull()
    expect(normalizeDomain('example-.com')).toBeNull()
    expect(normalizeDomain('<script>.com')).toBeNull()
    expect(normalizeDomain(`${'a'.repeat(64)}.com`)).toBeNull()
  })

  it('keeps localhost usable for development', () => {
    expect(normalizeDomain('localhost')).toBe('localhost')
    expect(normalizeDomain('http://localhost:5173')).toBe('localhost')
    expect(normalizeDomain('127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('originMatchesDomain', () => {
  it('matches the root and its subdomains', () => {
    expect(originMatchesDomain('https://example.com', 'example.com')).toBe(true)
    expect(originMatchesDomain('https://www.example.com', 'example.com')).toBe(true)
    expect(originMatchesDomain('https://app.example.com', 'example.com')).toBe(true)
    expect(originMatchesDomain('https://a.b.c.example.com', 'example.com')).toBe(true)
  })

  it('refuses a lookalike that merely ends with the domain', () => {
    // The whole reason the check is endsWith('.' + domain) and not
    // endsWith(domain).
    expect(originMatchesDomain('https://evil-example.com', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://notexample.com', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://xexample.com', 'example.com')).toBe(false)
  })

  it('refuses the domain appearing as a prefix of someone else’s hostname', () => {
    expect(originMatchesDomain('https://example.com.attacker.net', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://example.com.evil.co', 'example.com')).toBe(false)
  })

  it('refuses the domain hidden elsewhere in the URL', () => {
    // All of these contain "example.com" as a substring and none of them are it.
    expect(originMatchesDomain('https://attacker.net/example.com', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://attacker.net#example.com', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://example.com@attacker.net', 'example.com')).toBe(false)
    expect(originMatchesDomain('https://attacker.net?x=example.com', 'example.com')).toBe(false)
  })

  it('refuses plain http on a real domain', () => {
    // Otherwise anyone able to serve http on a matching hostname — a hijacked
    // network, a stripped connection — passes the check.
    expect(originMatchesDomain('http://example.com', 'example.com')).toBe(false)
    expect(originMatchesDomain('http://www.example.com', 'example.com')).toBe(false)
  })

  it('allows http for local development only', () => {
    expect(originMatchesDomain('http://localhost:5173', 'localhost')).toBe(true)
    expect(originMatchesDomain('http://localhost:8788', 'localhost')).toBe(true)
    expect(originMatchesDomain('http://127.0.0.1:3000', '127.0.0.1')).toBe(true)
    // And localhost does not stand in for a real domain.
    expect(originMatchesDomain('http://localhost:5173', 'example.com')).toBe(false)
  })

  it('refuses garbage rather than throwing', () => {
    expect(originMatchesDomain('not a url', 'example.com')).toBe(false)
    expect(originMatchesDomain('', 'example.com')).toBe(false)
    expect(originMatchesDomain('javascript:alert(1)', 'example.com')).toBe(false)
    expect(originMatchesDomain('null', 'example.com')).toBe(false)
  })

  it('is case insensitive on the hostname', () => {
    expect(originMatchesDomain('https://WWW.Example.COM', 'example.com')).toBe(true)
  })

  it('scopes to a subtree when the domain is itself a subdomain', () => {
    expect(originMatchesDomain('https://app.example.com', 'app.example.com')).toBe(true)
    expect(originMatchesDomain('https://eu.app.example.com', 'app.example.com')).toBe(true)
    // The apex is NOT covered by a subdomain entry.
    expect(originMatchesDomain('https://example.com', 'app.example.com')).toBe(false)
    expect(originMatchesDomain('https://other.example.com', 'app.example.com')).toBe(false)
  })
})

describe('originAllowed', () => {
  const domains = ['example.com', 'acme.io', 'localhost']

  it('admits any configured domain or its subdomains', () => {
    expect(originAllowed('https://example.com', domains)).toBe(true)
    expect(originAllowed('https://www.acme.io', domains)).toBe(true)
    expect(originAllowed('http://localhost:8788', domains)).toBe(true)
  })

  it('refuses everything else', () => {
    expect(originAllowed('https://attacker.net', domains)).toBe(false)
    expect(originAllowed('https://example.com.attacker.net', domains)).toBe(false)
    expect(originAllowed('https://evil-acme.io', domains)).toBe(false)
  })

  it('an empty list admits nothing', () => {
    // A site with no domains configured must fail closed, never open.
    expect(originAllowed('https://example.com', [])).toBe(false)
  })
})

describe('describeDomain', () => {
  it('says out loud that subdomains are included', () => {
    expect(describeDomain('example.com')).toBe('example.com and any subdomain')
    expect(describeDomain('localhost')).toBe('localhost (any port)')
  })
})

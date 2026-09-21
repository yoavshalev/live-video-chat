/**
 * A visitor identity is one browser, not one tab. Persisting it is what makes a
 * refresh keep its place in line and what stops two tabs becoming two people.
 *
 * Every access is guarded: Safari in Lock Down mode, private windows with site
 * data blocked, and embedded webviews all throw on `localStorage`. Losing the id
 * costs a place in line; throwing costs the whole widget.
 */

const STORAGE_KEY = 'founderlive.visitorId'

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

export function visitorIdentity(): string {
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

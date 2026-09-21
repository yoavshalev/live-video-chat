/**
 * Talking to whoever framed us.
 *
 * Media events are relayed to the parent (widget or dashboard), which owns the
 * live socket to the Durable Object. One socket per person, not two.
 *
 * `parentOrigin` was validated server-side against the site's allowed origins, so
 * this is a targeted post, never `'*'`. When we are the top-level tab there is no
 * parent and the HTTP fallback below is used instead.
 */

import { boot } from './boot'

export type ParentEvent = 'media-joined' | 'media-left' | 'ended' | 'iframe-blocked' | 'call-error'

export function notifyParent(type: ParentEvent): void {
  if (window.self === window.top) {
    void fetch('/api/call/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId: boot.callId,
        secret: boot.secret,
        who: boot.who,
        visitorId: boot.visitorId,
        joined: type === 'media-joined'
      })
    }).catch(() => {})
    return
  }
  try {
    window.parent.postMessage(
      { source: 'founderlive-call', type, callId: boot.callId },
      boot.parentOrigin ?? '*'
    )
  } catch {
    /* the parent went away; the server's own timeouts cover it */
  }
}

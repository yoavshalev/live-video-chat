/** What the server handed this page at render time (src/routes/call.tsx). */

export interface Boot {
  callId: string
  secret: string
  who: 'host' | 'visitor'
  visitorId: string | null
  peerName: string
  sdkUrl: string
  /** Validated server-side; the exact origin of the page framing us. */
  parentOrigin: string | null
}

export const boot = JSON.parse(document.getElementById('boot')?.textContent ?? '{}') as Boot

/** A one-line description of any thrown value, for status lines and hints. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

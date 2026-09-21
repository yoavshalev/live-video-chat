/**
 * Every tunable number and every piece of visitor-facing copy lives here.
 *
 * The rule this file exists to enforce: no string the visitor reads and no
 * timeout the state machine depends on may be written inline anywhere else.
 * When the wording of "I'm talking to someone right now" needs to change it
 * should change in one place, and when a grace period turns out to be wrong it
 * should be obvious what else it interacts with.
 */

export interface HostProfile {
  displayName: string
  avatarUrl: string | null
  loopVideoUrl: string | null
  loopPosterUrl: string | null
  headline: string
  subheadline: string
}

export interface RoomSettings {
  /** How long an invited visitor has to click "Join call" before we move on. */
  inviteTimeoutSeconds: number
  /**
   * A waiting visitor whose socket drops is kept in the queue this long. Mobile
   * Safari suspends backgrounded tabs aggressively; evicting on first disconnect
   * would silently drop people who did nothing wrong.
   */
  visitorDisconnectGraceSeconds: number
  /** Same idea for the host's dashboard: a blip must not take the site offline. */
  hostDisconnectGraceSeconds: number
  /** Once a call is live, how long either side may be gone before we end it. */
  activeCallReconnectSeconds: number
  /** How long we wait for both parties to actually reach the media room. */
  callConnectTimeoutSeconds: number
  /**
   * Who hands visitors to agents. 'auto' assigns round-robin whenever an agent
   * is free; 'manual' waits for an agent to press Accept. Organization-wide,
   * changeable from any dashboard; this is only the starting value.
   */
  assignment: 'auto' | 'manual'
  /**
   * After a call fails to provision (RealtimeKit down or misconfigured),
   * automatic assignment waits this long before inviting anyone again.
   */
  provisionRetrySeconds: number
  /** Below this many completed calls we show "2 people ahead" and no ETA. */
  minCallsForEstimate: number
  /** Rolling window used for the wait-time estimate. */
  estimateWindow: number
  /** Hard cap on queue length. Beyond it, joins are refused politely. */
  maxQueueLength: number
}

export const DEFAULT_SETTINGS: RoomSettings = {
  inviteTimeoutSeconds: 60,
  visitorDisconnectGraceSeconds: 90,
  hostDisconnectGraceSeconds: 45,
  activeCallReconnectSeconds: 30,
  callConnectTimeoutSeconds: 120,
  assignment: 'auto',
  provisionRetrySeconds: 30,
  minCallsForEstimate: 3,
  estimateWindow: 10,
  maxQueueLength: 25
}

export const DEFAULT_HOST_PROFILE: HostProfile = {
  displayName: 'Our team',
  avatarUrl: null,
  // Uploaded through the dashboard; served from R2 via /media/*. Null until then,
  // and the widget is designed to look intentional without it.
  loopVideoUrl: null,
  loopPosterUrl: null,
  headline: 'Talk to us',
  subheadline: 'Have a question? Someone is here right now.'
}

/**
 * Widget copy. `{name}` is substituted with the host's display name at render
 * time in the browser, so a rename never requires a redeploy of embedding sites.
 */
export const COPY = {
  liveHeadline: '{name} is live',
  liveBody: "I'm here right now. Have a question? Talk to me directly.",
  liveCta: 'Talk to {name}',

  busyHeadline: '{name} is live',
  busyBody: "I'm talking to someone right now.",
  busyCta: 'Get in line',

  pausedHeadline: '{name} is live',
  pausedBody: "I've paused new conversations for a moment.",

  offlineHeadline: '{name} is offline',
  offlineBody: 'Leave a question and I’ll get back to you.',
  offlineCta: 'Leave a question',

  // Shown over the looping clip. Deliberately reads as a status badge about the
  // person, never as a label on the video itself — see README "Honest presence".
  livePill: 'Live now',
  clipNote: 'Short intro clip — your call will be face to face.',

  joinTitle: 'Talk to {name}',
  joinConsent:
    'Joining starts a live video and audio conversation in your browser. Your camera and microphone stay off until you choose to join the call.',

  invitedTitle: '{name} is ready for you',
  invitedBody: "It's your turn.",

  endedTitle: 'Thanks for talking with {name}.'
} as const

/** Applies the one substitution the copy strings support. */
export function withName(template: string, name: string): string {
  return template.replace(/\{name\}/g, name)
}

/**
 * Wait estimates are rounded into buckets on purpose. "~13 minutes" reads as a
 * promise and will be wrong; "~15 min" reads as an estimate and is allowed to be.
 */
export function bucketWait(seconds: number): string {
  const minutes = seconds / 60
  if (minutes < 5) return 'under 5 min'
  if (minutes < 7.5) return '~5 min'
  if (minutes < 12.5) return '~10 min'
  if (minutes < 17.5) return '~15 min'
  return '20+ min'
}

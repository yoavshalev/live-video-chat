/**
 * Cloudflare RealtimeKit REST client.
 *
 * API surface verified against developers.cloudflare.com/realtime (Apr–Aug 2026):
 *   POST /client/v4/accounts/{account}/realtime/kit/{app}/meetings
 *   POST /client/v4/accounts/{account}/realtime/kit/{app}/meetings/{id}/participants
 *   DELETE .../meetings/{id}/participants/{participantId}
 * Auth is a standard Cloudflare API token (`Authorization: Bearer`) scoped to
 * Realtime / Realtime Admin.
 *
 * THIS MODULE IS SERVER-ONLY. The API token is an account credential; if it ever
 * reaches a browser bundle, anyone can create meetings on your account. What the
 * browser gets is a participant `authToken` — a per-participant JWT for one
 * meeting — handed over one call at a time by routes/api.ts.
 */

import type { Env } from '../types'

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface RealtimeCredentials {
  accountId: string
  appId: string
  apiToken: string
}

export class RealtimeKitError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'RealtimeKitError'
  }
}

/**
 * Returns null when RealtimeKit is not configured yet, rather than throwing.
 * Everything up to the moment of an actual call works without credentials, and a
 * half-configured deploy should fail at the point of use with a clear message —
 * not at boot with a blank 500 on the marketing site.
 */
export function realtimeCredentials(env: Env): RealtimeCredentials | null {
  const { CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_APP_ID, REALTIMEKIT_API_TOKEN } = env
  if (!CLOUDFLARE_ACCOUNT_ID || !REALTIMEKIT_APP_ID || !REALTIMEKIT_API_TOKEN) return null
  return { accountId: CLOUDFLARE_ACCOUNT_ID, appId: REALTIMEKIT_APP_ID, apiToken: REALTIMEKIT_API_TOKEN }
}

interface CloudflareEnvelope<T> {
  success?: boolean
  result?: T
  data?: T
  errors?: Array<{ message?: string; code?: number }>
}

async function call<T>(
  creds: RealtimeCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${API_BASE}/accounts/${creds.accountId}/realtime/kit/${creds.appId}${path}`
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${creds.apiToken}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  const text = await response.text()
  let parsed: CloudflareEnvelope<T> | null = null
  try {
    parsed = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null
  } catch {
    parsed = null
  }

  if (!response.ok) {
    const detail = parsed?.errors?.map((e) => e.message).filter(Boolean).join('; ') || text.slice(0, 200)
    throw new RealtimeKitError(`RealtimeKit ${method} ${path} failed (${response.status}): ${detail}`, response.status)
  }

  // The REST surface has used both `result` (Cloudflare convention) and `data`
  // (inherited from the pre-acquisition API) depending on endpoint and vintage.
  // Accepting either costs one line and removes a whole class of upgrade break.
  const payload = parsed?.result ?? parsed?.data
  if (payload === undefined) {
    throw new RealtimeKitError(`RealtimeKit ${method} ${path} returned no payload`, response.status)
  }
  return payload
}

export interface Meeting {
  id: string
  title?: string
}

export interface Participant {
  id: string
  /** The per-participant JWT the browser SDK initialises with. Short-lived by policy, not by API. */
  token: string
  name?: string
  custom_participant_id?: string
}

export async function createMeeting(creds: RealtimeCredentials, title: string): Promise<Meeting> {
  return call<Meeting>(creds, 'POST', '/meetings', { title })
}

/**
 * Adds one participant and returns their auth token.
 *
 * `preset_name` is what makes host and visitor different: the host preset carries
 * host controls, the visitor preset does not. `custom_participant_id` maps back to
 * our own id — never an email or anything else identifying, per Cloudflare's own
 * guidance and because this value is visible to the other participant.
 */
export async function addParticipant(
  creds: RealtimeCredentials,
  meetingId: string,
  input: { name: string; presetName: string; customParticipantId: string }
): Promise<Participant> {
  const raw = await call<Record<string, unknown>>(creds, 'POST', `/meetings/${meetingId}/participants`, {
    name: input.name,
    preset_name: input.presetName,
    custom_participant_id: input.customParticipantId
  })
  // Documented as `token` in the REST reference and `authToken` in the SDK
  // quickstart. Both spellings have shipped; read whichever is present.
  const token = (raw.token ?? raw.authToken) as string | undefined
  if (!token) throw new RealtimeKitError('participant response contained no auth token', 502)
  return {
    id: String(raw.id ?? ''),
    token,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    custom_participant_id:
      typeof raw.custom_participant_id === 'string' ? raw.custom_participant_id : undefined
  }
}

/**
 * Best-effort teardown after a call. Deleting the participants revokes their
 * tokens, which is what actually closes the room to a stale tab holding an old
 * invitation. Failures are logged and swallowed: a leaked empty meeting costs
 * nothing, while a throw here would strand the queue.
 */
export async function releaseMeeting(
  creds: RealtimeCredentials,
  meetingId: string,
  participantIds: string[]
): Promise<void> {
  await Promise.all(
    participantIds.map(async (participantId) => {
      try {
        await call<unknown>(creds, 'DELETE', `/meetings/${meetingId}/participants/${participantId}`)
      } catch (error) {
        console.error('[realtimekit] participant cleanup failed', error instanceof Error ? error.message : error)
      }
    })
  )
}

export interface Preset {
  id?: string
  name: string
}

/**
 * Lists the presets that actually exist on this app.
 *
 * Exists because "No preset found with name X" is the single most likely way a
 * correctly-credentialed deploy still fails: the default preset names depend on
 * how and when the app was created, and the only way to know them is to ask.
 * Surfaced through a host-only route so the answer never requires pasting an
 * account API token into a terminal.
 */
export async function listPresets(env: Env): Promise<string[]> {
  const creds = realtimeCredentials(env)
  if (!creds) throw new RealtimeKitError('RealtimeKit is not configured.', 500)
  const result = await call<Preset[] | { presets?: Preset[] }>(creds, 'GET', '/presets')
  const presets = Array.isArray(result) ? result : (result.presets ?? [])
  return presets.map((preset) => preset.name).filter((name): name is string => typeof name === 'string')
}

export interface ProvisionedCall {
  meetingId: string
  host: { participantId: string; authToken: string }
  visitor: { participantId: string; authToken: string }
}

/**
 * Creates the meeting and both participants for one accepted call.
 *
 * Exactly two participants are ever created, which is what makes "no third
 * participant can enter" true rather than aspirational: without a token issued by
 * this function there is no way into the room, and the room id alone is not one.
 */
export async function provisionCall(
  env: Env,
  input: { callId: string; hostName: string; visitorName: string; visitorId: string; hostId: string }
): Promise<ProvisionedCall> {
  const creds = realtimeCredentials(env)
  if (!creds) {
    throw new RealtimeKitError(
      'RealtimeKit is not configured. Set CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_APP_ID and REALTIMEKIT_API_TOKEN.',
      500
    )
  }

  const meeting = await createMeeting(creds, `FounderLive ${input.callId}`)
  try {
    return await addBoth(creds, env, meeting.id, input)
  } catch (error) {
    if (error instanceof RealtimeKitError && /preset/i.test(error.message)) {
      throw new RealtimeKitError(
        `${error.message} — check REALTIMEKIT_HOST_PRESET / REALTIMEKIT_VISITOR_PRESET against GET /api/host/realtimekit.`,
        error.status
      )
    }
    throw error
  }
}

async function addBoth(
  creds: RealtimeCredentials,
  env: Env,
  meetingId: string,
  input: { callId: string; hostName: string; visitorName: string; visitorId: string; hostId: string }
): Promise<ProvisionedCall> {
  const results = await Promise.allSettled([
    addParticipant(creds, meetingId, {
      name: input.hostName,
      presetName: env.REALTIMEKIT_HOST_PRESET,
      customParticipantId: `host_${input.hostId}`
    }),
    addParticipant(creds, meetingId, {
      name: input.visitorName,
      presetName: env.REALTIMEKIT_VISITOR_PRESET,
      customParticipantId: input.visitorId
    })
  ])

  // One seat created and the other refused (a bad preset name, a flaky
  // request) must not leave a live token behind in a meeting nobody will use.
  // The meeting record itself has no delete endpoint; without participants it
  // is inert.
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    const created = results.filter((r): r is PromiseFulfilledResult<Participant> => r.status === 'fulfilled').map((r) => r.value.id)
    if (created.length > 0) await releaseMeeting(creds, meetingId, created)
    throw failed.reason
  }
  const [host, visitor] = results.map((r) => (r as PromiseFulfilledResult<Participant>).value) as [Participant, Participant]

  return {
    meetingId,
    host: { participantId: host.id, authToken: host.token },
    visitor: { participantId: visitor.id, authToken: visitor.token }
  }
}

/** Media credentials for one call, and what redeeming them returns. */

/** Never leaves the object except through redeemCall. */
export interface CallTokens {
  meetingId: string
  hostToken: string
  visitorToken: string
  hostParticipantId: string
  visitorParticipantId: string
}

export const tokensKey = (callId: string): string => `call_tokens:${callId}`

export interface RedeemResult {
  ok: boolean
  error?: string
  meetingId?: string
  authToken?: string
  displayName?: string
}

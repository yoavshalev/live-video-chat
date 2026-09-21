/**
 * The RealtimeKit Core SDK's surface, narrowed to what this page uses, plus
 * how the page gets the SDK and its credentials.
 *
 * Typed locally rather than pulled from the package because the SDK is loaded
 * at runtime from our own /sdk route and never bundled — see src/routes/sdk.ts.
 */

import { boot } from './boot'

export interface RtkDevice {
  deviceId: string
  label: string
  kind: string
}

export interface RtkParticipant {
  id: string
  name?: string
  videoEnabled?: boolean
  audioEnabled?: boolean
  /** Raw microphone track. The SDK does NOT play it; we do, in peer.ts. */
  audioTrack?: MediaStreamTrack
  screenShareEnabled?: boolean
  screenShareTracks?: { video?: MediaStreamTrack; audio?: MediaStreamTrack }
  registerVideoElement(element: HTMLVideoElement): void
  deregisterVideoElement?(element: HTMLVideoElement): void
}

export interface RtkParticipantMap {
  toArray(): RtkParticipant[]
  get(id: string): RtkParticipant | undefined
  on(event: string, handler: (participant: RtkParticipant) => void): void
}

export interface RtkMeeting {
  self: {
    videoEnabled: boolean
    audioEnabled: boolean
    screenShareEnabled: boolean
    roomJoined: boolean
    /** Our own microphone track, replaced when the device changes. */
    audioTrack?: MediaStreamTrack
    enableVideo(): Promise<void>
    disableVideo(): Promise<void>
    enableScreenShare(): Promise<void>
    disableScreenShare(): Promise<void>
    enableAudio(): Promise<void>
    disableAudio(): Promise<void>
    getVideoDevices(): Promise<RtkDevice[]>
    getAudioDevices(): Promise<RtkDevice[]>
    getCurrentDevices(): { audio?: RtkDevice; video?: RtkDevice; speaker?: RtkDevice }
    setDevice(device: RtkDevice): Promise<void>
    registerVideoElement(element: HTMLVideoElement, isPreview?: boolean): void
    deregisterVideoElement(element: HTMLVideoElement): void
    on(event: string, handler: (...args: unknown[]) => void): void
  }
  participants: { joined: RtkParticipantMap }
  join(): Promise<void>
  leave(): Promise<void>
}

declare global {
  interface Window {
    RealtimeKitClient?: {
      init(options: { authToken: string; defaults?: { audio?: boolean; video?: boolean } }): Promise<RtkMeeting>
    }
  }
}

export function loadSdk(): Promise<void> {
  if (window.RealtimeKitClient) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = boot.sdkUrl
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the video SDK.'))
    document.head.append(script)
  })
}

/**
 * Provisioning runs in parallel with the invitation countdown, so by the time
 * anybody clicks Join the meeting usually exists. "Usually" is not "always",
 * hence the retry on 409 — the alternative is telling someone their call failed
 * when it was simply 300ms early.
 */
export async function fetchCredentials(attempt = 0): Promise<{ authToken: string; displayName: string }> {
  const response = await fetch('/api/call/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callId: boot.callId,
      secret: boot.secret,
      who: boot.who,
      visitorId: boot.visitorId
    })
  })

  if (response.status === 409 && attempt < 12) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    return fetchCredentials(attempt + 1)
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `credentials failed (${response.status})`)
  }
  return (await response.json()) as { authToken: string; displayName: string }
}

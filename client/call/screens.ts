/** The full-stage overlay: getting ready, the camera check, errors, waiting for the other side. */

import { allowMicrophoneHint } from './platform'
import { boot, describe } from './boot'
import { els } from './dom'
import { notifyParent } from './parent'

export function showOverlay(title: string, body = ''): void {
  els.overlay.classList.remove('hidden')
  els.title.textContent = title
  els.body.textContent = body
}

export function showError(message: string, options: { retry?: boolean; newTab?: boolean } = {}): void {
  els.error.classList.remove('hidden')
  els.error.textContent = message
  els.retry.classList.toggle('hidden', !options.retry)
  els.newTab.classList.toggle('hidden', !options.newTab)
  if (options.newTab) els.newTab.href = location.href
  // Always offered. Whatever went wrong, the visitor must be able to walk away.
  els.abandon.classList.remove('hidden')
  els.join.classList.add('hidden')
  // Tells the widget to put its own close control back, since it hides it for
  // the duration of a call and this call is not going to happen.
  notifyParent('call-error')
}

export function clearError(): void {
  els.error.classList.add('hidden')
  els.retry.classList.add('hidden')
  els.newTab.classList.add('hidden')
  els.abandon.classList.add('hidden')
}

/** Hides the pre-call check's pieces; used when the overlay is repurposed. */
export function hideSetup(): void {
  els.overlay.classList.remove('setup')
  els.preview.classList.add('hidden')
  els.devices.classList.add('hidden')
  els.autoJoinWrap.classList.add('hidden')
  els.join.classList.add('hidden')
}

export function showWaitingForPeer(waiting: boolean): void {
  if (!waiting) {
    els.overlay.classList.add('hidden')
    return
  }
  els.overlay.classList.remove('hidden')
  clearError()
  hideSetup()
  showOverlay(
    boot.who === 'host' ? 'Waiting for them to join…' : `Waiting for ${boot.peerName || 'the host'}…`,
    'Hold on — reconnecting takes a few seconds.'
  )
}

/**
 * Whether this frame is even permitted to ask for a camera.
 *
 * A cross-origin iframe without `allow="camera; microphone"` cannot get media no
 * matter what the visitor clicks, and the failure surfaces as an ordinary
 * permission denial — which would send them to browser settings to fix something
 * that is not broken there. Detecting it up front is what makes the "open in a
 * new tab" escape hatch appear at the right moment.
 */
export function framePermitsMedia(): boolean {
  if (window.self === window.top) return true
  try {
    const policy = (document as unknown as { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy
    if (policy?.allowsFeature) {
      return policy.allowsFeature('camera') && policy.allowsFeature('microphone')
    }
  } catch {
    /* not supported here; fall through to the weaker check */
  }
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

/** Turns a getUserMedia-style failure into the right message and the right way out. */
export function handleMediaError(error: unknown): void {
  const name = (error as { name?: string } | null)?.name ?? ''
  const inFrame = window.self !== window.top

  if (name === 'NotAllowedError' || /permission/i.test(describe(error))) {
    notifyParent('iframe-blocked')
    showError(
      `Camera or microphone access was blocked. ${allowMicrophoneHint()}${inFrame ? ' Or open the call in its own tab.' : ''}`,
      { retry: true, newTab: inFrame }
    )
    return
  }
  if (name === 'NotFoundError') {
    showError('No camera or microphone was found on this device.', { retry: true })
    return
  }
  if (name === 'NotReadableError') {
    showError('Your camera is in use by another app. Close it and try again.', { retry: true })
    return
  }
  showError(describe(error), { retry: true, newTab: inFrame })
}

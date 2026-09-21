/** The bar under the stage: mute, camera, screen share. (End call lives in lifecycle.ts.) */

import { describe } from './boot'
import { els } from './dom'
import { call } from './state'
import { toggleCamera, toggleMicrophone } from './microphone'
import { showError } from './screens'

export function syncShareButton(): void {
  const on = Boolean(call.meeting?.self.screenShareEnabled)
  els.shareButton.classList.toggle('on', on)
  els.shareButton.setAttribute('aria-pressed', String(on))
  els.shareButton.setAttribute('aria-label', on ? 'Stop sharing your screen' : 'Share your screen')
  els.sharePill.classList.toggle('hidden', !on)
}

/** Once, right after join. */
export function wireControls(): void {
  els.mic.onclick = () => void toggleMicrophone()
  els.cam.onclick = () => void toggleCamera()

  // Screen share exists only where the browser can capture a screen — no
  // mobile browser can, so the button is simply absent there rather than
  // present and broken.
  if (navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices) {
    els.shareButton.classList.remove('hidden')
    els.shareButton.onclick = async () => {
      const meeting = call.meeting
      if (!meeting) return
      try {
        if (meeting.self.screenShareEnabled) await meeting.self.disableScreenShare()
        else await meeting.self.enableScreenShare()
      } catch (error) {
        // Cancelling the browser's picker rejects too; that is not an error
        // worth showing.
        const name = (error as { name?: string } | null)?.name ?? ''
        if (name !== 'NotAllowedError' && name !== 'AbortError') showError(describe(error))
      }
      syncShareButton()
    }
    // The browser's own "Stop sharing" bar ends a share behind our back.
    call.meeting?.self.on('screenShareUpdate', () => syncShareButton())
  }
}

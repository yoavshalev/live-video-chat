/**
 * Getting the agent's attention: a chime that repeats while somebody is
 * waiting and YOU are free to take them, a flashing tab title so a
 * backgrounded dashboard still gets noticed, and a browser notification if
 * you have allowed them. Which of these actually fire is decided in
 * ./alerts.ts; this is only the plumbing.
 */

import { createChime } from '../shared/chime'
import { NAG_INTERVAL_MS, TITLE_FLASH_MS, nagTitle, shouldNag } from './alerts'
import { els } from './dom'
import { live, myStatus } from './state'

const SOUND_KEY = 'founderlive.host.sound'

export const alerts = {
  soundEnabled: (() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off'
    } catch {
      return true
    }
  })()
}

export const chime = createChime({ gain: 0.12 })
let nagTimer: ReturnType<typeof setInterval> | null = null
let titleTimer: ReturnType<typeof setInterval> | null = null
const originalTitle = document.title

async function unlockAudio(): Promise<void> {
  const ok = await chime.unlock()
  if (ok) syncAlerts()
}

/** Starts or stops the nag, from the current queue and status. */
export function syncAlerts(): void {
  const nag = shouldNag({ queueLength: live.queue.length, hostStatus: myStatus(), soundEnabled: alerts.soundEnabled })
  els.soundLocked.classList.toggle('hidden', !(nag && !chime.unlocked))
  if (nag) {
    if (!nagTimer) nagTimer = setInterval(() => chime.play(), NAG_INTERVAL_MS)
    if (!titleTimer) {
      let on = false
      titleTimer = setInterval(() => {
        on = !on
        document.title = on ? nagTitle(live.queue.length) : originalTitle
      }, TITLE_FLASH_MS)
    }
  } else {
    if (nagTimer) clearInterval(nagTimer)
    nagTimer = null
    if (titleTimer) clearInterval(titleTimer)
    titleTimer = null
    document.title = originalTitle
  }
}

function renderSoundToggle(): void {
  els.sound.textContent = alerts.soundEnabled ? 'Sound on' : 'Sound off'
  els.sound.setAttribute('aria-pressed', String(alerts.soundEnabled))
  els.sound.classList.toggle('muted-toggle', !alerts.soundEnabled)
}

/** One notification per arrival, only while the tab is hidden and only if allowed. */
export function notifyJoin(firstName: string, siteId: string): void {
  if (document.visibilityState === 'visible') return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(`${firstName} is waiting to talk`, { body: `From ${siteId}. Open the dashboard to accept.`, tag: 'founderlive-host' })
  } catch {
    /* some browsers need a service worker for this */
  }
}

/** Once, at start-up: the sound button, and unlocking audio on the first gesture. */
export function wireAttention(): void {
  // Browsers refuse to play sound until you have clicked something on the page.
  window.addEventListener('pointerdown', () => void unlockAudio(), { capture: true })
  window.addEventListener('keydown', () => void unlockAudio(), { capture: true })

  els.sound.onclick = async () => {
    alerts.soundEnabled = !alerts.soundEnabled
    try {
      localStorage.setItem(SOUND_KEY, alerts.soundEnabled ? 'on' : 'off')
    } catch {
      /* per-browser preference; losing it costs one extra click */
    }
    renderSoundToggle()
    if (alerts.soundEnabled) {
      await unlockAudio()
      chime.play()
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {})
    }
    syncAlerts()
  }
  renderSoundToggle()
}

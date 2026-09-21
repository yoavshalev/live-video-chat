/**
 * Per-browser call preferences: which camera, microphone and speaker to use,
 * and whether an agent wants to skip the pre-call check.
 *
 * Kept in localStorage on OUR origin, which the dashboard and the call iframe
 * share, so a device picked on the dashboard's "Check camera" is the one the
 * next call starts with. Not stored on the server on purpose: a deviceId only
 * means something to the browser that issued it, and the same person on a
 * laptop and a desktop has two different right answers.
 *
 * Devices are remembered by id AND label. Browsers rotate deviceIds (Safari
 * does so per session), and the label is what survives that.
 */

export const PREFS_KEY = 'founderlive.call.prefs.v1'

export interface DevicePref {
  id: string
  label: string
}

export interface CallPrefs {
  audioinput?: DevicePref
  videoinput?: DevicePref
  audiooutput?: DevicePref
  /** Agents only: join as soon as the devices are up, without the check screen. */
  autoJoin?: boolean
}

export function loadPrefs(): CallPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as CallPrefs) : {}
  } catch {
    // Storage can be unavailable inside a cross-site iframe (Safari) or a
    // private window. Then every call simply starts from the browser default.
    return {}
  }
}

export function savePrefs(patch: Partial<CallPrefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    /* see loadPrefs */
  }
}

/** The remembered device among those currently present, by id first, then by label. */
export function pickRemembered<T extends { deviceId: string; label: string }>(devices: T[], pref: DevicePref | undefined): T | undefined {
  if (!pref) return undefined
  return devices.find((d) => d.deviceId === pref.id) ?? devices.find((d) => d.label !== '' && d.label === pref.label)
}

/**
 * Where the call page is running, for the few things that differ by platform:
 * whether a capture may start on its own, and the words that tell somebody
 * how to let their browser use the microphone. Everything else on the page is
 * the same everywhere.
 */

const ua = navigator.userAgent

/** iPhone and iPad, every browser: all of them are WebKit there. */
export const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isAndroid = /Android/.test(ua)

/**
 * Which app is wrapping WebKit on iOS. Chrome, Firefox and Edge there each
 * gate the microphone behind their own switch in iOS Settings and their own
 * per-site prompt, so a refusal has to be explained per app.
 */
export const iosBrowser: 'Safari' | 'Chrome' | 'Firefox' | 'Edge' | null = !isIOS
  ? null
  : /CriOS/.test(ua)
    ? 'Chrome'
    : /FxiOS/.test(ua)
      ? 'Firefox'
      : /EdgiOS/.test(ua)
        ? 'Edge'
        : 'Safari'

const desktopBrowser: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'other' = /Edg\//.test(ua)
  ? 'Edge'
  : /Firefox\//.test(ua)
    ? 'Firefox'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : 'other'

const os: 'ios' | 'android' | 'mac' | 'windows' | 'other' = isIOS
  ? 'ios'
  : isAndroid
    ? 'android'
    : /Mac/.test(navigator.platform)
      ? 'mac'
      : /Win/.test(navigator.platform)
        ? 'windows'
        : 'other'

/** Some in-app browsers have no camera or microphone API at all. */
export function canCaptureAtAll(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

/** How to lift a microphone block, in this browser, on this device. */
export function allowMicrophoneHint(): string {
  if (iosBrowser === 'Safari') return 'Tap “aA” in the address bar → Website Settings → Microphone → Allow, then reload.'
  if (iosBrowser) {
    return `On your iPhone open Settings → ${iosBrowser} → Microphone and turn it on, then come back, reload, and tap Allow when ${iosBrowser} asks.`
  }
  if (isAndroid) return 'Tap the lock icon next to the address → Permissions → Microphone → Allow, then reload.'
  if (desktopBrowser === 'Firefox') return 'Click the microphone icon in the address bar, clear the block, then reload and click Allow.'
  if (desktopBrowser === 'Safari') return 'In the Safari menu choose “Settings for This Website…” → Microphone → Allow, then reload.'
  if (desktopBrowser === 'Chrome' || desktopBrowser === 'Edge') {
    return 'Click the icon at the left of the address → Site settings → Microphone → Allow, then reload.'
  }
  return 'Allow the microphone for this site in your browser’s address bar, then reload.'
}

/** What to check when the system keeps muting a microphone that was captured fine. */
export function systemMuteHint(): string {
  if (os === 'ios' || os === 'android') return 'Bring this app to the front and end any other call that is using the microphone.'
  if (os === 'mac') return 'Check System Settings → Privacy & Security → Microphone allows your browser, and that no other app holds the microphone.'
  if (os === 'windows') return 'Check Settings → Privacy → Microphone allows your browser, and that no other app holds the microphone.'
  return 'Check that no other app is using the microphone.'
}

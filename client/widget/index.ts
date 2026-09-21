/**
 * FounderLive — the embeddable widget.
 *
 *   <script src="https://live.example.com/widget.js" data-site="example"></script>
 *
 * This file is the bootstrap and the public API; the widget itself is
 * ./widget.ts and its screens are ./views. The API
 * (`FounderLive.init/open/close/destroy/getStatus`) and the `founderlive:*`
 * events exist so host applications can react — open the widget from their own
 * CTA, or track it in their own analytics.
 */

import type { InitOptions } from './types'
import { Widget } from './widget'

/**
 * The base URL is read from this script's own `src` rather than configured,
 * which is what keeps widget.js completely static and therefore cacheable for an
 * hour: there is nothing deployment-specific inside it.
 */
function resolveBaseUrl(): string {
  const current = document.currentScript as HTMLScriptElement | null
  const src = current?.src ?? findWidgetScript()?.src
  if (!src) return location.origin
  try {
    return new URL(src).origin
  } catch {
    return location.origin
  }
}

function findWidgetScript(): HTMLScriptElement | null {
  const scripts = Array.from(document.getElementsByTagName('script'))
  return scripts.find((script) => /\/widget(\/v\d+)?\.js/.test(script.src)) ?? null
}

let instance: Widget | null = null

const api = {
  init(options: InitOptions): void {
    if (instance) return
    if (!options?.siteId) return
    instance = new Widget(resolveBaseUrl(), options)
    void instance.start()
  },
  open(): void {
    instance?.open()
  },
  close(): void {
    instance?.close()
  },
  destroy(): void {
    instance?.destroy()
    instance = null
  },
  getStatus() {
    return instance?.status() ?? null
  }
}

declare global {
  interface Window {
    FounderLive?: typeof api
  }
}

window.FounderLive = api

// Auto-initialise from the script tag's data attributes, so the common case is
// one line of HTML and no JavaScript at all.
const tag = (document.currentScript as HTMLScriptElement | null) ?? findWidgetScript()
const siteId = tag?.dataset.site
if (siteId) {
  const boot = () =>
    api.init({
      siteId,
      position: tag?.dataset.position as InitOptions['position'],
      theme: tag?.dataset.theme as InitOptions['theme'],
      accentColor: tag?.dataset.accent
    })
  // `document.body` must exist before anything is mounted, and a widget must
  // never be the reason a page's own load event is late.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
}

export {}

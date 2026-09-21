/** The HTML shell every first-party dashboard page renders into. */

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import { BASE_STYLES } from '../../ui/styles'

/** What an `html` tagged template returns; partials hand these to each other. */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>

export function layout(title: string, body: Html, extraStyles = ''): Html {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title}</title>
    <style>
      ${raw(BASE_STYLES)}
      ${raw(extraStyles)}
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`
}

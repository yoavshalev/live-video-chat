/**
 * Serves demo/ on http://localhost:8788 — a different origin from the Worker on
 * :8787, which is the entire reason this exists rather than adding a /demo route.
 *
 * Loading the widget from the Worker's own domain would silently skip every
 * cross-origin path in the product: the Origin allow-list, CORS on /embed/config,
 * the cross-origin WebSocket upgrade, `frame-ancestors` on the call page, and the
 * postMessage target check. Those are where embedding actually breaks.
 *
 * Node's own http module; no dependency, because a static file server for one
 * HTML file does not need one.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo')
const PORT = 8788

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  // `normalize` plus the prefix check keeps `../` out of a server that is running
  // on a developer's machine with their whole home directory behind it.
  const file = normalize(join(root, relative))
  if (!file.startsWith(root)) {
    response.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await readFile(file)
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    response.end(body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
  }
}).listen(PORT, () => {
  console.log(`Demo site  → http://localhost:${PORT}`)
  console.log(`Dashboard  → http://localhost:8787/host`)
  console.log(`\nStart the Worker separately with \`npm run dev\`.`)
})

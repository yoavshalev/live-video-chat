#!/usr/bin/env node
/**
 * Deploys the Worker — after refusing to deploy the template.
 *
 *   npm run deploy -- --config wrangler.<name>.local.jsonc
 *
 * wrangler.jsonc in the repository is a template with placeholder ids and an
 * example hostname. `wrangler deploy` run against it fails late and confusingly
 * (an invalid D1 id, a route on a zone you do not own), and the tempting fix —
 * editing the template in place — ends with real resource ids committed to a
 * public repository. So: every deploy names its config, the config is checked
 * for leftover placeholders, the full check (build, typecheck, tests) runs, and
 * only then does wrangler deploy.
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// `--config file`, `--config=file` and `-c file` all mean the same thing to
// wrangler, so they do here too; everything else is passed through untouched.
const args = process.argv.slice(2)
let config = 'wrangler.jsonc'
const passthrough = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const inline = arg.match(/^(?:--config|-c)=(.+)$/)
  if (inline) config = inline[1]
  else if (arg === '--config' || arg === '-c') config = args[++i] ?? ''
  else passthrough.push(arg)
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

if (!config || !existsSync(config)) fail(`No such config file: ${config}`)

const text = readFileSync(config, 'utf8')
const leftovers = [...new Set([...text.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((m) => m[0]))]
if (/live\.example\.com/.test(text)) leftovers.push('live.example.com')
if (leftovers.length > 0) {
  fail(
    `${config} still has template values: ${leftovers.join(', ')}\n\n` +
      'Copy the template and fill in your own resources (see README, "Deploying to Cloudflare"):\n' +
      '  cp wrangler.jsonc wrangler.prod.local.jsonc      # any wrangler.*.local.jsonc is gitignored\n' +
      '  npm run deploy -- --config wrangler.prod.local.jsonc'
  )
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// The same gate `npm run check` is: client bundles, both typechecks, unit tests.
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], { shell: process.platform === 'win32' })

// wrangler itself, without a shell, so arguments arrive exactly as given.
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
if (!existsSync(wrangler)) fail('wrangler is not installed — run npm install first.')
run(process.execPath, [wrangler, 'deploy', '--config', config, ...passthrough])

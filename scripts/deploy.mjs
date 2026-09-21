#!/usr/bin/env node
/**
 * Deploys the Worker, and does the things a deployment cannot work without.
 *
 *   npm run deploy                                        # wrangler.jsonc
 *   npm run deploy -- --config wrangler.<name>.local.jsonc
 *
 * In order:
 *   1. Refuse a config that still has template placeholders — `wrangler deploy`
 *      fails late and confusingly on those, and the tempting fix (editing the
 *      template in place) ends with real resource ids in a public repository.
 *   2. Build, typecheck and test (`npm run check`). Under Workers Builds, which
 *      is what the "Deploy to Cloudflare" button runs, only the client bundles
 *      are built: the tests are the repository's gate, not a stranger's.
 *   3. Apply D1 migrations. Idempotent, so it runs on every deploy.
 *   4. `wrangler deploy`.
 *   5. Fill in the two secrets a fresh deployment cannot work without and nobody
 *      should have to invent: SESSION_SECRET (generated) and CLOUDFLARE_ACCOUNT_ID
 *      (read from the config, the environment, or `wrangler whoami`). Only when
 *      missing — an existing value is never touched, because rotating the
 *      session secret signs everybody out.
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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

const inWorkersBuilds = Boolean(process.env.WORKERS_CI || process.env.CI)
const windows = process.platform === 'win32'

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

function step(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

if (!config || !existsSync(config)) fail(`No such config file: ${config}`)

const text = readFileSync(config, 'utf8')
const leftovers = [...new Set([...text.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((m) => m[0]))]
if (leftovers.length > 0) {
  fail(
    `${config} still has template values: ${leftovers.join(', ')}\n\n` +
      'Either deploy with the button in the README, which creates the resources and fills these in,\n' +
      'or create them yourself and keep the ids out of git (see README, "Deploying by hand"):\n' +
      '  cp wrangler.jsonc wrangler.prod.local.jsonc      # any wrangler.*.local.jsonc is gitignored\n' +
      '  npm run deploy -- --config wrangler.prod.local.jsonc'
  )
}

// wrangler itself, without a shell, so arguments arrive exactly as given.
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
if (!existsSync(wrangler)) fail('wrangler is not installed — run npm install first.')

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function wranglerRun(wranglerArgs, options = {}) {
  run(process.execPath, [wrangler, ...wranglerArgs, '--config', config], options)
}

/**
 * Runs wrangler and returns its stdout, or null if it failed. Only stdout:
 * wrangler puts warnings such as "[ERROR] Failed to write to log file" on
 * stderr while still exiting 0, and a bracket from one of those inside what we
 * parse as JSON would read as "no secrets" — and regenerate a session secret
 * that was fine, signing everybody out on an otherwise routine deploy.
 */
function wranglerCapture(wranglerArgs) {
  const result = spawnSync(process.execPath, [wrangler, ...wranglerArgs, '--config', config], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : null
}

step(inWorkersBuilds ? 'Build' : 'Check')
run(windows ? 'npm.cmd' : 'npm', ['run', inWorkersBuilds ? 'build' : 'check'], { shell: windows })

step('D1 migrations')
wranglerRun(['d1', 'migrations', 'apply', 'DB', '--remote'])

step('Deploy')
wranglerRun(['deploy', ...passthrough])

step('Secrets')
const names = parseSecretNames(wranglerCapture(['secret', 'list', '--format', 'json']))
if (names === null) {
  // Not knowing is not the same as knowing there are none. Nothing is written.
  console.warn('Could not read the list of secrets; leaving them alone. On a new deployment, set them by hand:')
  console.warn('  npx wrangler secret put SESSION_SECRET\n  npx wrangler secret put CLOUDFLARE_ACCOUNT_ID')
} else {
  const existing = new Set(names)

  if (existing.has('SESSION_SECRET')) console.log('SESSION_SECRET: set')
  else putSecret('SESSION_SECRET', randomBytes(32).toString('base64url'), 'generated')

  if (existing.has('CLOUDFLARE_ACCOUNT_ID')) console.log('CLOUDFLARE_ACCOUNT_ID: set')
  else {
    const accountId = detectAccountId()
    if (accountId) putSecret('CLOUDFLARE_ACCOUNT_ID', accountId, 'detected')
    else console.warn('CLOUDFLARE_ACCOUNT_ID: not set and not detectable — npx wrangler secret put CLOUDFLARE_ACCOUNT_ID')
  }

  for (const name of ['REALTIMEKIT_APP_ID', 'REALTIMEKIT_API_TOKEN']) {
    if (!existing.has(name)) console.warn(`${name}: not set — calls cannot start until it is (README, "RealtimeKit")`)
  }
}

/** The secret names in `wrangler secret list --format json` output, or null if it cannot be trusted. */
function parseSecretNames(stdout) {
  if (stdout === null) return null
  // A JSON array on its own; tolerate a banner line before it, nothing after.
  const start = stdout.indexOf('[')
  if (start < 0 || !stdout.trimEnd().endsWith(']')) return null
  try {
    const parsed = JSON.parse(stdout.slice(start))
    if (!Array.isArray(parsed) || !parsed.every((secret) => typeof secret?.name === 'string')) return null
    return parsed.map((secret) => secret.name)
  } catch {
    return null
  }
}

function putSecret(name, value, how) {
  const result = spawnSync(process.execPath, [wrangler, 'secret', 'put', name, '--config', config], {
    input: value,
    stdio: ['pipe', 'ignore', 'inherit']
  })
  if (result.status === 0) console.log(`${name}: ${how} and set`)
  else console.warn(`${name}: could not be set — npx wrangler secret put ${name}`)
}

function detectAccountId() {
  const fromConfig = text.match(/"account_id"\s*:\s*"([0-9a-f]{32})"/)
  if (fromConfig) return fromConfig[1]
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID
  if (fromEnv && /^[0-9a-f]{32}$/.test(fromEnv)) return fromEnv
  // `wrangler whoami` lists every account the credentials can reach. Only an
  // unambiguous answer is used.
  const whoami = wranglerCapture(['whoami'])
  const ids = [...new Set((whoami ?? '').match(/\b[0-9a-f]{32}\b/g) ?? [])]
  return ids.length === 1 ? ids[0] : null
}

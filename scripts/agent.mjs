#!/usr/bin/env node
/**
 * Manage agents from the command line.
 *
 *   node scripts/agent.mjs add   --name "Ariel" --email ariel@example.com [--password ...] [--role admin] [--id ariel] [--remote]
 *   node scripts/agent.mjs password --email ariel@example.com [--password ...] [--remote]
 *   node scripts/agent.mjs list  [--remote]
 *   node scripts/agent.mjs disable --email ariel@example.com [--remote]
 *   node scripts/agent.mjs enable  --email ariel@example.com [--remote]
 *
 * `--remote` acts on the deployed D1 database; without it, on the local one.
 * `--config <file>` passes a wrangler config (e.g. wrangler.prod.local.jsonc) through.
 * Omit --password and a strong one is generated and printed ONCE.
 *
 * This is how the first admin is created on a fresh deployment. There is no web
 * setup page on purpose: an unauthenticated "create the first admin" form is a
 * race that whoever finds the URL first wins, and a CLI that needs wrangler's
 * own credentials has no such window.
 *
 * Hashing must match src/lib/password.ts byte for byte — test/password.test.ts
 * checks that a hash produced here verifies there.
 */

import { spawnSync } from 'node:child_process'
import { webcrypto as crypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The most the Workers runtime will verify; see src/lib/password.ts.
export const PBKDF2_ITERATIONS = 100_000

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`
}

export function generatePassword() {
  // No look-alike characters, grouped for typing: k7fq-2mzt-9rwb-h4xn (≈80 bits).
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => alphabet[b % alphabet.length]).join('')
  return [pick(4), pick(4), pick(4), pick(4)].join('-')
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
}

/** SQL string literal. Single quotes doubled; nothing else can escape a literal in SQLite. */
const q = (value) => `'${String(value).replace(/'/g, "''")}'`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++ } else args[key] = true
    } else args._.push(a)
  }
  return args
}

/** Set from --config in main(); every wrangler call below carries it. */
let wranglerConfig = null

/**
 * Runs wrangler without a shell, so the SQL reaches it as one argument. Going
 * through `npx` on Windows means cmd.exe, which re-splits every argument on
 * spaces and turns a SELECT into "Unknown arguments: id,, name,, …".
 */
function wrangler(args) {
  const local = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  if (existsSync(local)) return spawnSync(process.execPath, [local, ...args], { encoding: 'utf8' })
  // No local install (e.g. run outside the repo): fall back to npx, quoting for cmd.exe.
  const quote = (a) => (process.platform === 'win32' && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return spawnSync('npx', ['wrangler', ...args].map(quote), { encoding: 'utf8', shell: process.platform === 'win32' })
}

function d1(sql, remote) {
  const database = process.env.D1_DATABASE ?? 'founderlive'
  const flags = [remote ? '--remote' : '--local', ...(wranglerConfig ? ['--config', wranglerConfig] : [])]
  const result = wrangler(['d1', 'execute', database, ...flags, '--command', sql])
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr)
    throw new Error(`wrangler d1 execute failed (${result.status})`)
  }
  const match = result.stdout.match(/\[\s*\{[\s\S]*\]/)
  try { return match ? JSON.parse(match[0])[0]?.results ?? [] : [] } catch { return [] }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const remote = Boolean(args.remote)
  if (typeof args.config === 'string') wranglerConfig = args.config
  const where = remote ? 'REMOTE (production)' : 'local'
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : ''

  if (cmd === 'list') {
    const rows = d1('SELECT id, name, email, role, enabled, password_hash IS NOT NULL AS has_password, created_at FROM agents ORDER BY created_at', remote)
    if (rows.length === 0) { console.log(`No agents (${where}). Create one with: node scripts/agent.mjs add --name ... --email ...${remote ? ' --remote' : ''}`); return }
    for (const r of rows) console.log(`${r.enabled ? ' on ' : 'off '} ${String(r.id).padEnd(16)} ${String(r.name).padEnd(20)} ${String(r.email).padEnd(30)} ${r.role}${r.has_password ? '' : '  (no password — Access mode)'}`)
    return
  }

  if (cmd === 'add') {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name || !email.includes('@')) throw new Error('add needs --name and --email')
    const role = args.role === 'admin' ? 'admin' : 'agent'
    const id = typeof args.id === 'string' ? slugify(args.id) : slugify(name)
    const password = typeof args.password === 'string' ? args.password : generatePassword()
    if (password.length < 12) throw new Error('password must be at least 12 characters')
    const hash = await hashPassword(password)
    d1(`INSERT INTO agents (id, name, email, password_hash, role, enabled, created_at) VALUES (${q(id)}, ${q(name)}, ${q(email)}, ${q(hash)}, ${q(role)}, 1, ${Date.now()})`, remote)
    console.log(`\nAgent created (${where}).\n`)
    console.log(`  id:       ${id}\n  name:     ${name}\n  email:    ${email}\n  role:     ${role}`)
    if (typeof args.password !== 'string') console.log(`\n  PASSWORD: ${password}\n\n  Shown once. Give it to them and have them change it from the dashboard.`)
    console.log()
    return
  }

  if (cmd === 'password') {
    if (!email.includes('@')) throw new Error('password needs --email')
    const password = typeof args.password === 'string' ? args.password : generatePassword()
    if (password.length < 12) throw new Error('password must be at least 12 characters')
    const hash = await hashPassword(password)
    d1(`UPDATE agents SET password_hash = ${q(hash)} WHERE email = ${q(email)}`, remote)
    console.log(`\nPassword set for ${email} (${where}).`)
    if (typeof args.password !== 'string') console.log(`\n  PASSWORD: ${password}\n`)
    return
  }

  if (cmd === 'disable' || cmd === 'enable') {
    if (!email.includes('@')) throw new Error(`${cmd} needs --email`)
    d1(`UPDATE agents SET enabled = ${cmd === 'enable' ? 1 : 0} WHERE email = ${q(email)}`, remote)
    console.log(`${email} ${cmd}d (${where}).`)
    return
  }

  console.log(`usage: node scripts/agent.mjs <add|password|list|disable|enable> [--remote] [--config wrangler.x.local.jsonc] ...`)
  process.exit(cmd ? 1 : 0)
}

// Only run as a CLI; the test imports hashPassword without side effects.
if (process.argv[1] && /agent\.mjs$/.test(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exit(1) })
}

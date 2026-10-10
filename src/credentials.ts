/**
 * Where the API key comes from, and the `login` / `logout` / `status` commands.
 *
 * Why a key file and not just APIMODELS_API_KEY (0.5.0): agent apps launched from the
 * Dock / Start menu (Codex desktop, Claude desktop) do not inherit the variables a user
 * sets in their shell profile, and a plugin's MCP config cannot carry a secret. So the
 * plugin route would break exactly for desktop users. `npx -y apimodels-mcp login`
 * stores the key once, in the user's home directory, and every client that launches
 * this server finds it — no per-client config, nothing to paste into a chat.
 *
 * Lookup order: APIMODELS_API_KEY (non-empty) → the credentials file. The file is read
 * again whenever no key is cached, so logging in while an agent is running works
 * without restarting it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

export const KEYS_URL = 'https://apimodels.app/console/api-keys'

export function credentialsPath(): string {
  return process.env.APIMODELS_CREDENTIALS_FILE || join(homedir(), '.apimodels', 'credentials.json')
}

export type KeySource = { key: string; source: 'env' | 'file' }

function readFileKey(): string | null {
  try {
    const p = credentialsPath()
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { api_key?: unknown }
    return typeof j.api_key === 'string' && j.api_key.trim() ? j.api_key.trim() : null
  } catch {
    return null
  }
}

let cached: KeySource | null = null

/** The key to use right now, or null. Env wins; the file is re-read until a key is found. */
export function resolveKey(): KeySource | null {
  if (cached) return cached
  const env = process.env.APIMODELS_API_KEY?.trim()
  if (env) return (cached = { key: env, source: 'env' })
  const file = readFileKey()
  return file ? (cached = { key: file, source: 'file' }) : null
}

export function mask(key: string): string {
  return key.length > 10 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '****'
}

async function fetchBalance(baseUrl: string, key: string): Promise<{ ok: true; balance: number; currency: string } | { ok: false; status: number; msg: string }> {
  const res = await fetch(`${baseUrl}/balance`, { headers: { Authorization: `Bearer ${key}` } })
  const j: any = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, status: res.status, msg: j?.msg || `HTTP ${res.status}` }
  const d = j?.data ?? j
  return { ok: true, balance: Number(d?.balance ?? 0), currency: String(d?.currency ?? 'USD') }
}

/** Read one line without echoing it (TTY), or the whole of stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let s = ''
    for await (const c of process.stdin) s += c
    return s.trim()
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
  let muted = false
  out._writeToOutput = (s: string) => { if (!muted) out.output.write(s) }
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()) })
    muted = true
  })
}

const say = (s: string) => process.stdout.write(`${s}\n`)

export async function runCli(cmd: string, args: string[], baseUrl: string): Promise<number> {
  if (cmd === 'login') {
    const i = args.indexOf('--key')
    const key = i >= 0 ? (args[i + 1] || '').trim() : await readSecret(`Paste your apimodels API key (from ${KEYS_URL}): `)
    if (!/^sk[_-][A-Za-z0-9_-]{8,}$/.test(key)) {
      say('That does not look like an apimodels API key (they start with sk_). Nothing was saved.')
      return 1
    }
    let check: Awaited<ReturnType<typeof fetchBalance>>
    try {
      check = await fetchBalance(baseUrl, key)
    } catch (e) {
      say(`Could not reach ${baseUrl} to verify the key (${e instanceof Error ? e.message : e}). Nothing was saved.`)
      return 1
    }
    if (!check.ok) {
      say(`The key was rejected (HTTP ${check.status}: ${check.msg}). Nothing was saved. Create a key at ${KEYS_URL}`)
      return 1
    }
    const p = credentialsPath()
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    writeFileSync(p, JSON.stringify({ api_key: key, saved_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(p, 0o600) } catch { /* Windows: ACLs, not modes */ }
    say(`Logged in as ${mask(key)} — balance ${check.balance.toFixed(4)} ${check.currency}.`)
    say(`Key saved to ${p}. Codex, Claude Code and any other MCP client using apimodels-mcp will pick it up; no restart needed.`)
    return 0
  }
  if (cmd === 'logout') {
    const p = credentialsPath()
    if (existsSync(p)) { rmSync(p); say(`Removed ${p}.`) } else say(`No saved key at ${p}.`)
    if (process.env.APIMODELS_API_KEY) say('Note: APIMODELS_API_KEY is still set in this environment and is used first.')
    return 0
  }
  if (cmd === 'status') {
    const k = resolveKey()
    if (!k) { say(`No API key found. Run: npx -y apimodels-mcp login   (keys: ${KEYS_URL})`); return 1 }
    say(`Key ${mask(k.key)} from ${k.source === 'env' ? 'APIMODELS_API_KEY' : credentialsPath()}.`)
    try {
      const b = await fetchBalance(baseUrl, k.key)
      say(b.ok ? `Balance: ${b.balance.toFixed(4)} ${b.currency}` : `The key was rejected (HTTP ${b.status}: ${b.msg}).`)
      return b.ok ? 0 : 1
    } catch (e) {
      say(`Could not reach ${baseUrl} (${e instanceof Error ? e.message : e}).`)
      return 1
    }
  }
  say('Usage: apimodels-mcp [login [--key sk_…] | logout | status]   (no argument: run the MCP server on stdio)')
  return cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1
}

export const CLI_COMMANDS = new Set(['login', 'logout', 'status', 'help', '--help', '-h'])

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
 *
 * `login` (0.6.0) authorizes in the browser — nothing to copy or paste, and an agent can run
 * it for the user: we listen on 127.0.0.1:<random port>, open
 * https://apimodels.app/cli-auth?port=…&state=…, the signed-in user clicks Authorize, the site
 * redirects to http://127.0.0.1:<port>/callback?code=…&state=… (RFC 8252 loopback), and we trade
 * the one-time code (128-bit, 10 min, single use) for a new key named "CLI · <date>" at
 * POST /api/cli-auth/exchange. The key never appears in a URL, a page or a chat. The state we
 * generate must come back unchanged, so a page that is not ours cannot push a code to us.
 * `--key sk_…` and `--stdin` remain for scripts and headless machines.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

export const KEYS_URL = 'https://apimodels.app/console/api-keys'
const SITE_URL = (process.env.APIMODELS_SITE_URL || 'https://apimodels.app').replace(/\/$/, '')
const AUTH_TIMEOUT_MS = 10 * 60_000

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

function openBrowser(url: string): void {
  // rundll32 on Windows: `start` would split the URL at "&"
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => { /* no browser: the URL is printed anyway */ })
    child.unref()
  } catch { /* same */ }
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#0b0b0c;color:#eee;display:flex;min-height:90vh;align-items:center;justify-content:center">
<div style="max-width:420px;text-align:center"><h2>${title}</h2><p style="color:#aaa">${body}</p></div></body>`

/** Browser authorization: returns a fresh API key, or throws with a message for the user. */
async function browserLogin(noBrowser: boolean): Promise<string> {
  const state = randomBytes(16).toString('hex')
  let settle!: (r: { code?: string; error?: string }) => void
  const result = new Promise<{ code?: string; error?: string }>((r) => { settle = r })
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
    const code = u.searchParams.get('code') || ''
    if (u.searchParams.get('state') !== state || !/^[0-9a-f]{32}$/.test(code)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(PAGE('Authorization failed / 授权失败', 'This link does not match the login that is waiting. Run <code>apimodels-mcp login</code> again. / 链接与正在等待的登录不匹配,请重新运行登录命令。'))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(PAGE('Authorized / 授权完成', 'You can close this tab and go back to your agent. / 可以关闭此页面,回到你的智能体继续。'))
    settle({ code })
  })
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', () => r()) })
  const port = (server.address() as { port: number }).port
  const url = `${SITE_URL}/cli-auth?port=${port}&state=${state}`
  say('Authorize apimodels in your browser (sign in there if asked, then click Authorize):')
  say(`  ${url}`)
  if (!noBrowser) openBrowser(url)
  say('Waiting for authorization… (Ctrl+C to cancel)')
  const timer = setTimeout(() => settle({ error: 'Timed out after 10 minutes without authorization.' }), AUTH_TIMEOUT_MS)
  const got = await result
  clearTimeout(timer)
  server.close()
  if (!got.code) throw new Error(got.error || 'Authorization did not complete.')
  const res = await fetch(`${SITE_URL}/api/cli-auth/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: got.code }),
  })
  const j: any = await res.json().catch(() => ({}))
  const key = j?.data?.apiKey
  if (!res.ok || typeof key !== 'string') throw new Error(`Could not finish authorization (${j?.msg || `HTTP ${res.status}`}). Run the login command again.`)
  return key
}

export async function runCli(cmd: string, args: string[], baseUrl: string): Promise<number> {
  if (cmd === 'login') {
    const i = args.indexOf('--key')
    let key: string
    if (i >= 0) key = (args[i + 1] || '').trim()
    else if (args.includes('--stdin') || args.includes('--paste')) key = await readSecret(`Paste your apimodels API key (from ${KEYS_URL}): `)
    else {
      try {
        key = await browserLogin(args.includes('--no-browser'))
      } catch (e) {
        say(e instanceof Error ? e.message : String(e))
        say(`Alternatively create a key at ${KEYS_URL} and run: npx -y apimodels-mcp login --paste`)
        return 1
      }
    }
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
  say('Usage: apimodels-mcp login [--no-browser | --paste | --stdin | --key sk_…] | logout | status')
  say('  login           authorize in the browser (default); --paste prompts for a key; --stdin reads one; --key passes one')
  say('  (no argument)   run the MCP server on stdio')
  return cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1
}

export const CLI_COMMANDS = new Set(['login', 'logout', 'status', 'help', '--help', '-h'])

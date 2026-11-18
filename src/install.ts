/**
 * `apimodels-mcp install` / `apimodels-mcp uninstall` (0.10.0): find the MCP clients on this
 * machine and add (or remove) the apimodels server in each one's own config.
 *
 *   npx -y apimodels-mcp install              list what was found, ask Y/n per client
 *   npx -y apimodels-mcp install --yes        all of them, no questions
 *   npx -y apimodels-mcp install --dry-run    print the exact changes, write nothing
 *   npx -y apimodels-mcp install --client cursor,vscode
 *   npx -y apimodels-mcp install --local      the local stdio server everywhere (reads local files)
 *   npx -y apimodels-mcp uninstall [--yes] [--dry-run] [--client …]
 *
 * Default is the hosted server https://api.apimodels.app/mcp: the client signs in with OAuth on
 * first use, so there is no key to store. Clients whose config file cannot hold a remote server
 * (Claude Desktop: remote servers are added as Connectors in its UI) get the local stdio server
 * `npx -y apimodels-mcp`, and `apimodels-mcp login` runs once if no key is saved yet.
 *
 * Safety rules, enforced below and by scripts/install-test.mjs:
 *  - never overwrite: JSON/JSONC files are edited in place by jsonc.ts (comments, order,
 *    indentation and line endings survive), Codex's TOML via `codex mcp add` or toml-lite.ts;
 *  - an existing "apimodels" entry that differs from ours is kept unless the user confirms
 *    replacing it (interactive y/N, or --replace);
 *  - a timestamped copy `<file>.apimodels-backup-<UTC stamp>` is written next to every file
 *    before it changes, including the files the claude / codex CLIs are about to change;
 *  - every edited file is parsed again and compared with the intended result before it is
 *    written; a file we cannot parse is left alone and manual steps are printed;
 *  - nothing is written in --dry-run, and a second run changes nothing.
 *
 * Config locations, verified against each client's own documentation on 2026-11-18:
 *  - Claude Code: official CLI `claude mcp add --transport http --scope user <name> <url>`;
 *    user-scope servers live in ~/.claude.json → mcpServers (read only, to see what is there).
 *    https://code.claude.com/docs/en/mcp
 *  - Codex (CLI, IDE extension and desktop app share it): `codex mcp add <name> --url <url>`,
 *    `codex mcp login <name>`; [mcp_servers.<name>] url = … in ~/.codex/config.toml ($CODEX_HOME).
 *    https://learn.chatgpt.com/docs/extend/mcp?surface=cli (was developers.openai.com/codex/mcp)
 *  - Claude Desktop: claude_desktop_config.json → mcpServers (stdio only; remote servers are
 *    Connectors in Settings). macOS ~/Library/Application Support/Claude/, Windows %APPDATA%\Claude\,
 *    Linux ~/.config/Claude/.
 *    https://modelcontextprotocol.io/docs/develop/connect-local-servers
 *    https://modelcontextprotocol.io/docs/develop/connect-remote-servers
 *  - Cursor: ~/.cursor/mcp.json → mcpServers, remote = { "url" }, OAuth supported.
 *    https://cursor.com/docs/context/mcp
 *  - VS Code: profile mcp.json (the file "MCP: Open User Configuration" opens) → servers,
 *    { "type": "http", "url" }. Default profile = the User folder: macOS ~/Library/Application
 *    Support/Code/User, Windows %APPDATA%\Code\User, Linux ~/.config/Code/User.
 *    https://code.visualstudio.com/docs/agents/reference/mcp-configuration
 *    https://code.visualstudio.com/docs/configure/settings (User folder per OS)
 *  - Windsurf, now Devin Desktop (docs.windsurf.com/windsurf/cascade/mcp redirects to
 *    docs.devin.ai/desktop/cascade/mcp): Cascade's "Open MCP config file" opens
 *    ~/.config/devin/mcp_config.json ($XDG_CONFIG_HOME/devin), Windows %AppData%/devin/mcp_config.json;
 *    mcpServers → { "serverUrl" or "url" }, OAuth supported. The Devin CLI reads the same file.
 *    https://docs.devin.ai/windsurf/plugins/cascade/mcp.md
 *    https://docs.devin.ai/cli/extensibility/mcp/configuration.md
 *  - Gemini CLI: ~/.gemini/settings.json → mcpServers, Streamable HTTP = { "httpUrl" },
 *    OAuth discovered automatically, `/mcp auth <name>`.
 *    https://geminicli.com/docs/tools/mcp-server/
 *  - OpenCode: ~/.config/opencode/opencode.json(c) → mcp.servers.<name> = { "type": "remote",
 *    "url" } ("V2 does not place server names directly under mcp"); OAuth on by default.
 *    https://opencode.ai/docs/mcp-servers/  https://opencode.ai/docs/config/
 *  - WorkBuddy: no documented config file (Tencent's guide only describes the 自定义连接器
 *    button), so only manual steps are printed.
 *    https://cloud.tencent.com/document/product/1831/134525
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseJsonc, toValue, lookup, setMember, removeMember, JsoncError } from './jsonc.js'
import { findCodexServer, appendCodexServer, removeCodexServer, type CodexEntry } from './toml-lite.js'
import { runCli, hasSavedKey } from './credentials.js'

export const REMOTE_URL = 'https://api.apimodels.app/mcp'
const NAME = 'apimodels'
const LOCAL = { command: 'npx', args: ['-y', 'apimodels-mcp'] }
const LOCAL_CMD = `${LOCAL.command} ${LOCAL.args.join(' ')}`

type Platform = 'darwin' | 'win32' | 'linux'
type Mode = 'remote' | 'local'

interface Env {
  platform: Platform
  home: string
  appData: string // Windows %APPDATA%
  xdgConfig: string // $XDG_CONFIG_HOME or ~/.config
  codexHome: string
  claudeJson: string
}

function makeEnv(): Env {
  // APIMODELS_INSTALL_PLATFORM only exists so the tests can lay out Windows / Linux paths in a fake HOME.
  const forced = process.env.APIMODELS_INSTALL_PLATFORM
  const platform: Platform = forced === 'win32' || forced === 'linux' || forced === 'darwin'
    ? forced : process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const home = homedir()
  return {
    platform,
    home,
    appData: process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    xdgConfig: process.env.XDG_CONFIG_HOME || join(home, '.config'),
    codexHome: process.env.CODEX_HOME || join(home, '.codex'),
    claudeJson: join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
  }
}

/** Per-OS application config folder (Electron's appData): Claude Desktop, VS Code. */
function appConfigDir(env: Env, app: string): string {
  if (env.platform === 'darwin') return join(env.home, 'Library', 'Application Support', app)
  if (env.platform === 'win32') return join(env.appData, app)
  return join(env.xdgConfig, app)
}

// ─── clients ────────────────────────────────────────────────────────────────

type Entry = Record<string, unknown>

interface JsonClient {
  kind: 'json'
  id: string
  name: string
  modes: Mode[] // first = default
  detect(env: Env): boolean
  file(env: Env): string
  path: string[] // container of the servers map
  entry(mode: Mode): Entry
  matches(existing: unknown, mode: Mode): boolean
  /** Extra refusal for layouts we do not know (OpenCode V1). */
  guard?(root: unknown): string | null
  newFile?(entry: Entry): unknown
  signIn: string
}
interface CliClient<K extends 'claude' | 'codex'> {
  kind: K
  id: string
  name: string
  modes: Mode[]
  detect(env: Env): boolean
  signIn: string
}
type Client = JsonClient | CliClient<'claude'> | CliClient<'codex'>

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sameArgs = (a: unknown) => Array.isArray(a) && a.length === LOCAL.args.length && a.every((x, k) => x === LOCAL.args[k])

const CLIENTS: Client[] = [
  {
    kind: 'claude', id: 'claude-code', name: 'Claude Code', modes: ['remote', 'local'],
    detect: (env) => !!which('claude') || existsSync(env.claudeJson) || existsSync(join(env.home, '.claude')),
    signIn: 'in Claude Code run /mcp, pick apimodels, Authenticate (or: claude mcp login apimodels)',
  },
  {
    kind: 'codex', id: 'codex', name: 'Codex', modes: ['remote', 'local'],
    detect: (env) => !!which('codex') || existsSync(env.codexHome),
    signIn: 'codex mcp login apimodels',
  },
  {
    kind: 'json', id: 'claude-desktop', name: 'Claude Desktop', modes: ['local'],
    detect: (env) => existsSync(appConfigDir(env, 'Claude')),
    file: (env) => join(appConfigDir(env, 'Claude'), 'claude_desktop_config.json'),
    path: ['mcpServers'],
    entry: () => ({ ...LOCAL, args: [...LOCAL.args] }),
    matches: (e) => isObj(e) && e.command === LOCAL.command && sameArgs(e.args),
    signIn: 'restart Claude Desktop (quit it fully). Prefer the hosted server? Settings → Connectors → Add custom connector → ' + REMOTE_URL,
  },
  {
    kind: 'json', id: 'cursor', name: 'Cursor', modes: ['remote', 'local'],
    detect: (env) => existsSync(join(env.home, '.cursor')),
    file: (env) => join(env.home, '.cursor', 'mcp.json'),
    path: ['mcpServers'],
    entry: (mode) => (mode === 'remote' ? { url: REMOTE_URL } : { ...LOCAL, args: [...LOCAL.args] }),
    matches: (e, mode) => isObj(e) && (mode === 'remote' ? e.url === REMOTE_URL && !e.command : e.command === LOCAL.command && sameArgs(e.args)),
    signIn: 'in Cursor open Customize → MCPs and click Authenticate next to apimodels',
  },
  {
    kind: 'json', id: 'vscode', name: 'VS Code', modes: ['remote', 'local'],
    detect: (env) => existsSync(join(appConfigDir(env, 'Code'), 'User')),
    file: (env) => join(appConfigDir(env, 'Code'), 'User', 'mcp.json'),
    path: ['servers'],
    entry: (mode) => (mode === 'remote' ? { type: 'http', url: REMOTE_URL } : { type: 'stdio', ...LOCAL, args: [...LOCAL.args] }),
    matches: (e, mode) => isObj(e) && (mode === 'remote' ? e.type === 'http' && e.url === REMOTE_URL : e.command === LOCAL.command && sameArgs(e.args)),
    signIn: 'VS Code asks you to sign in the first time Copilot Chat starts the server',
  },
  {
    kind: 'json', id: 'windsurf', name: 'Windsurf / Devin Desktop', modes: ['remote', 'local'],
    detect: (env) => existsSync(dirname(devinFile(env))) || existsSync(join(env.home, '.codeium', 'windsurf')),
    file: (env) => devinFile(env),
    path: ['mcpServers'],
    entry: (mode) => (mode === 'remote' ? { url: REMOTE_URL } : { ...LOCAL, args: [...LOCAL.args] }),
    matches: (e, mode) => isObj(e) && (mode === 'remote' ? (e.url ?? e.serverUrl) === REMOTE_URL && !e.command : e.command === LOCAL.command && sameArgs(e.args)),
    signIn: 'refresh the MCP list in Cascade and sign in when asked',
  },
  {
    kind: 'json', id: 'gemini', name: 'Gemini CLI', modes: ['remote', 'local'],
    detect: (env) => existsSync(join(env.home, '.gemini')) || !!which('gemini'),
    file: (env) => join(env.home, '.gemini', 'settings.json'),
    path: ['mcpServers'],
    entry: (mode) => (mode === 'remote' ? { httpUrl: REMOTE_URL } : { ...LOCAL, args: [...LOCAL.args] }),
    matches: (e, mode) => isObj(e) && (mode === 'remote' ? e.httpUrl === REMOTE_URL && !e.command : e.command === LOCAL.command && sameArgs(e.args)),
    signIn: 'in Gemini CLI run /mcp auth apimodels',
  },
  {
    kind: 'json', id: 'opencode', name: 'OpenCode', modes: ['remote', 'local'],
    detect: (env) => existsSync(join(env.xdgConfig, 'opencode')) || !!which('opencode'),
    file: (env) => {
      const dir = join(env.xdgConfig, 'opencode')
      return existsSync(join(dir, 'opencode.jsonc')) ? join(dir, 'opencode.jsonc') : join(dir, 'opencode.json')
    },
    path: ['mcp', 'servers'],
    entry: (mode) => (mode === 'remote' ? { type: 'remote', url: REMOTE_URL } : { type: 'local', command: [LOCAL.command, ...LOCAL.args] }),
    matches: (e, mode) => isObj(e) && (mode === 'remote'
      ? e.type === 'remote' && e.url === REMOTE_URL
      : e.type === 'local' && Array.isArray(e.command) && e.command.join(' ') === LOCAL_CMD),
    guard: (root) => {
      const mcp = isObj(root) ? root.mcp : undefined
      if (mcp === undefined) return null
      if (!isObj(mcp)) return '"mcp" is not an object'
      const other = Object.keys(mcp).filter((k) => k !== 'servers')
      return other.length ? `"mcp" lists servers directly (${other.join(', ')}), the older layout; current OpenCode expects them under "mcp.servers"` : null
    },
    newFile: (entry) => ({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { [NAME]: entry } } }),
    signIn: 'run opencode mcp auth apimodels (or /mcps in OpenCode)',
  },
]

function devinFile(env: Env): string {
  return env.platform === 'win32' ? join(env.appData, 'devin', 'mcp_config.json') : join(env.xdgConfig, 'devin', 'mcp_config.json')
}

export const CLIENT_IDS = CLIENTS.map((c) => c.id)
const ALIASES: Record<string, string> = { claude: 'claude-code', 'claude-code': 'claude-code', code: 'vscode', 'vs-code': 'vscode', devin: 'windsurf', 'gemini-cli': 'gemini', desktop: 'claude-desktop' }

// ─── helpers ────────────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      try {
        if (!statSync(p).isFile()) continue
        if (process.platform !== 'win32') accessSync(p, constants.X_OK)
        return p
      } catch { /* not here */ }
    }
  }
  return null
}

function run(cmd: string, args: string[], interactive = false): { ok: boolean; out: string } {
  const exe = which(cmd)
  if (!exe) return { ok: false, out: `${cmd} not found on PATH` }
  // .cmd / .bat shims on Windows only start through a shell (Node refuses them otherwise).
  const shell = /\.(cmd|bat)$/i.test(exe)
  const r = spawnSync(shell ? `"${exe}"` : exe, shell ? args.map((a) => `"${a}"`) : args, {
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell,
    timeout: interactive ? 15 * 60_000 : 120_000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { ok: r.status === 0, out: r.error ? `${out} ${r.error.message}`.trim() : out }
}

const tilde = (env: Env, p: string) => (p.startsWith(env.home + '/') || p.startsWith(env.home + '\\') ? '~' + p.slice(env.home.length) : p)

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/** Copy file → file.apimodels-backup-<stamp> (same permissions); returns the backup path. */
function backup(file: string): string | null {
  if (!existsSync(file)) return null
  const base = `${file}.apimodels-backup-${stamp()}`
  let dest = base
  for (let k = 2; existsSync(dest); k++) dest = `${base}-${k}`
  copyFileSync(file, dest)
  try { chmodSync(dest, statSync(file).mode & 0o777) } catch { /* Windows */ }
  return dest
}

/** Minimal line diff: one hunk from the first to the last changed line, 2 lines of context. */
function diff(before: string | null, after: string, label: string): string {
  const split = (s: string) => s.replace(/\r?\n$/, '').split(/\r?\n/)
  const a = before === null ? [] : split(before)
  const b = split(after)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const out = [`    --- ${label}${before === null ? ' (new file)' : ''}`, `    +++ ${label}`, `    @@ line ${p + 1} @@`]
  for (let k = Math.max(0, p - 2); k < p; k++) out.push(`      ${a[k]}`)
  for (let k = p; k < a.length - s; k++) out.push(`    - ${a[k]}`)
  for (let k = p; k < b.length - s; k++) out.push(`    + ${b[k]}`)
  for (let k = a.length - s; k < Math.min(a.length, a.length - s + 2); k++) out.push(`      ${a[k]}`)
  return redact(out.join('\n'))
}

const say = (s = '') => process.stdout.write(`${s}\n`)

/** API keys in an existing entry (env, headers) are shown as sk_…1234: this output may land in an agent transcript. */
const redact = (s: string) => s.replace(/\b(sk[_-])[A-Za-z0-9_-]{6,}/g, (m, p) => `${p}…${m.slice(-4)}`)
const show = (v: unknown) => redact(JSON.stringify(v))

/** Questions read from stdin line by line (works for a terminal and for piped answers). */
class Asker {
  private lines: string[] = []
  private waiting: ((s: string | null) => void) | null = null
  private closed = false
  private rl = createInterface({ input: process.stdin, terminal: false })
  constructor() {
    this.rl.on('line', (l) => { if (this.waiting) { const w = this.waiting; this.waiting = null; w(l) } else this.lines.push(l) })
    this.rl.on('close', () => { this.closed = true; if (this.waiting) { const w = this.waiting; this.waiting = null; w(null) } })
  }
  /** null = no answer possible (stdin closed). */
  async ask(q: string, def: boolean): Promise<boolean | null> {
    process.stdout.write(`${q} ${def ? '[Y/n]' : '[y/N]'} `)
    const line = this.lines.length ? this.lines.shift()! : this.closed ? null : await new Promise<string | null>((r) => { this.waiting = r })
    if (line === null) { say(); return null }
    if (!process.stdin.isTTY) say(line)
    const t = line.trim().toLowerCase()
    return t === '' ? def : t === 'y' || t === 'yes'
  }
  close() { this.rl.close() }
}

// ─── state per client ───────────────────────────────────────────────────────

type State =
  | { status: 'absent' }
  | { status: 'same' }
  | { status: 'different'; existing: unknown }
  | { status: 'blocked'; reason: string } // cannot touch it safely: print manual steps

interface Target {
  client: Client
  mode: Mode
  detected: boolean
  where: string // file path or "claude CLI"
  state: State
  cli: boolean // the official CLI is available (claude / codex)
}

function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)

function jsonState(c: JsonClient, file: string, mode: Mode): State {
  const raw = readText(file)
  if (raw === null || !raw.trim()) return { status: 'absent' }
  try {
    const root = parseJsonc(stripBom(raw))
    const g = c.guard?.(toValue(root))
    if (g) return { status: 'blocked', reason: g }
    const hit = lookup(root, c.path, NAME)
    if (!hit.found) return { status: 'absent' }
    return c.matches(hit.value, mode) ? { status: 'same' } : { status: 'different', existing: hit.value }
  } catch (e) {
    return { status: 'blocked', reason: e instanceof JsoncError ? `cannot parse it: ${e.message}` : String(e) }
  }
}

function claudeState(env: Env, mode: Mode): State {
  const raw = readText(env.claudeJson)
  if (raw === null) return { status: 'absent' }
  try {
    const e = (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers?.[NAME]
    if (e === undefined) return { status: 'absent' }
    const ok = isObj(e) && (mode === 'remote' ? e.type === 'http' && e.url === REMOTE_URL : e.command === LOCAL.command && sameArgs(e.args))
    return ok ? { status: 'same' } : { status: 'different', existing: e }
  } catch {
    return { status: 'absent' } // the claude CLI owns this file; let it decide
  }
}

function codexFile(env: Env) { return join(env.codexHome, 'config.toml') }

function codexState(env: Env, mode: Mode): State {
  const raw = readText(codexFile(env))
  if (raw === null) return { status: 'absent' }
  const f = findCodexServer(raw, NAME)
  if (f.kind === 'none') return { status: 'absent' }
  if (f.kind === 'other') return { status: 'blocked', reason: `[mcp_servers.${NAME}] is written in a form this installer does not edit (line ${f.line})` }
  const v = f.values
  const ok = mode === 'remote' ? v.url === REMOTE_URL && !v.command : v.command === LOCAL.command && sameArgs(v.args)
  return ok ? { status: 'same' } : { status: 'different', existing: v }
}

function targetFor(c: Client, env: Env, forceLocal: boolean): Target {
  const mode: Mode = forceLocal && c.modes.includes('local') ? 'local' : c.modes[0]
  const detected = c.detect(env)
  if (c.kind === 'json') return { client: c, mode, detected, where: c.file(env), state: jsonState(c, c.file(env), mode), cli: false }
  if (c.kind === 'claude') {
    const cli = !!which('claude')
    const state = claudeState(env, mode)
    return { client: c, mode, detected, where: cli ? `claude CLI (user scope, ${tilde(env, env.claudeJson)})` : env.claudeJson, state, cli }
  }
  const cli = !!which('codex')
  return { client: c, mode, detected, where: cli ? `codex CLI (${tilde(env, codexFile(env))})` : codexFile(env), state: codexState(env, mode), cli }
}

// ─── the commands ───────────────────────────────────────────────────────────

interface Opts { yes: boolean; dryRun: boolean; replace: boolean; local: boolean; login: boolean; clients: string[] | null }

function parseArgs(args: string[]): Opts | string {
  const o: Opts = { yes: false, dryRun: false, replace: false, local: false, login: true, clients: null }
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--yes' || a === '-y') o.yes = true
    else if (a === '--dry-run' || a === '-n') o.dryRun = true
    else if (a === '--replace') o.replace = true
    else if (a === '--local') o.local = true
    else if (a === '--no-login') o.login = false
    else if (a === '--client' || a.startsWith('--client=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++k]
      if (!v) return '--client needs a name'
      const ids: string[] = []
      for (const raw of v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        const id = ALIASES[raw] ?? raw
        if (id === 'workbuddy') { ids.push(id); continue }
        if (!CLIENT_IDS.includes(id)) return `Unknown client "${raw}". Known: ${[...CLIENT_IDS, 'workbuddy'].join(', ')}`
        ids.push(id)
      }
      o.clients = [...(o.clients ?? []), ...ids]
    } else if (a === '--help' || a === '-h') return 'help'
    else return `Unknown option ${a}`
  }
  return o
}

const USAGE = `Usage:
  npx -y apimodels-mcp install [--yes] [--dry-run] [--client <names>] [--local] [--replace] [--no-login]
  npx -y apimodels-mcp uninstall [--yes] [--dry-run] [--client <names>]

Finds the MCP clients on this machine and adds apimodels to each one's config (asks first).
  --yes          do it for every client found, without asking
  --dry-run      print the exact changes and write nothing
  --client       only these, comma-separated: ${[...CLIENT_IDS, 'workbuddy'].join(', ')}
                 (a named client is configured even if it does not look installed)
  --local        use the local server (npx -y apimodels-mcp) everywhere instead of the hosted one;
                 it can read files on this machine, and needs Node.js 18+ when the client starts it
  --replace      replace an existing "apimodels" entry that differs (otherwise it is kept)
  --no-login     do not open a browser to sign in at the end

Hosted server: ${REMOTE_URL} (each client signs in with OAuth on first use).
A timestamped backup is written next to every file before it changes.`

const MANUAL_GUI = `WorkBuddy, ChatGPT, Claude.ai and other apps with a connector screen: add a custom connector
  (WorkBuddy: 连接器 → 自定义连接器) with the URL ${REMOTE_URL} and sign in when asked.`

export async function runInstaller(cmd: 'install' | 'uninstall', argv: string[], baseUrl: string): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === 'help') { say(USAGE); return 0 }
  if (typeof parsed === 'string') { say(parsed); say(); say(USAGE); return 2 }
  const o = parsed
  const env = makeEnv()
  const uninstall = cmd === 'uninstall'

  const wanted = o.clients ? CLIENTS.filter((c) => o.clients!.includes(c.id)) : CLIENTS
  const targets = wanted.map((c) => targetFor(c, env, o.local)).filter((t) => o.clients || t.detected)
  const missing = o.clients ? [] : CLIENTS.filter((c) => !targets.some((t) => t.client === c))

  say(uninstall ? 'apimodels-mcp uninstall' : `apimodels-mcp install — ${o.local ? 'local server (npx -y apimodels-mcp)' : `hosted server ${REMOTE_URL}`}`)
  if (o.dryRun) say('Dry run: nothing will be written.')
  say()
  if (!targets.length) {
    say(o.clients?.includes('workbuddy') ? '' : 'No MCP clients found on this machine.')
  } else {
    say(o.clients ? 'Clients:' : `Found ${targets.length} MCP client${targets.length > 1 ? 's' : ''}:`)
    for (const t of targets) {
      const status = t.state.status === 'same' ? (uninstall ? 'has apimodels' : 'already set up')
        : t.state.status === 'different' ? 'has a different "apimodels" entry'
          : t.state.status === 'blocked' ? 'cannot edit automatically'
            : uninstall ? 'no apimodels entry' : `will add (${t.mode === 'remote' ? 'hosted, OAuth' : 'local, npx'})`
      say(`  ${t.client.name.padEnd(26)}${status.padEnd(34)}${tilde(env, t.where)}`)
    }
  }
  if (missing.length) say(`Not found: ${missing.map((c) => c.name).join(', ')}`)
  say()

  const asker = o.yes || o.dryRun ? null : new Asker()
  const results: Array<{ t: Target; result: string; next?: string }> = []
  const backups: string[] = []
  let failed = false
  let needLogin = false
  let codexLogin = false
  let stopAsking = false

  for (const t of targets) {
    const c = t.client
    const s = t.state
    if (s.status === 'blocked') {
      failed = true
      results.push({ t, result: `skipped: ${s.reason}`, next: manualSteps(t, env, uninstall) })
      continue
    }
    if (uninstall ? s.status === 'absent' : s.status === 'same') {
      results.push({ t, result: uninstall ? 'nothing to remove' : 'already set up, unchanged' })
      if (!uninstall && !o.dryRun && t.mode === 'local') needLogin = true // still needs a key on this machine
      continue
    }
    if (c.kind === 'claude' && !t.cli) {
      results.push({ t, result: 'skipped: the claude command is not on PATH', next: manualSteps(t, env, uninstall) })
      continue
    }
    const replacing = !uninstall && s.status === 'different'
    if (replacing && !o.replace && (o.yes || o.dryRun)) {
      results.push({ t, result: `kept the existing "apimodels" entry (${show((s as { existing: unknown }).existing)}); re-run with --replace --client ${c.id} to replace it` })
      continue
    }
    if (asker && !stopAsking) {
      const q = uninstall ? `Remove apimodels from ${c.name}?`
        : replacing ? `${c.name} already has an "apimodels" entry: ${show((s as { existing: unknown }).existing)}\n  Replace it with ${t.mode === 'remote' ? REMOTE_URL : LOCAL_CMD}?`
          : `Add apimodels to ${c.name} (${tilde(env, t.where)})?`
      const yes = await asker.ask(q, !replacing)
      if (yes === null) { stopAsking = true; say('No answer (stdin closed): nothing more is changed. Re-run with --yes to apply.') }
      else if (!yes) { results.push({ t, result: 'skipped (your choice)' }); continue }
    }
    if (asker && stopAsking) { results.push({ t, result: 'not changed (no answer)' }); continue }

    try {
      const r = c.kind === 'json' ? applyJson(c, t, env, o, uninstall, backups)
        : c.kind === 'claude' ? applyClaude(t, env, o, uninstall, replacing, backups)
          : applyCodex(t, env, o, uninstall, replacing, backups)
      results.push({ t, result: r, next: uninstall || o.dryRun ? undefined : c.signIn })
      if (!uninstall && !o.dryRun && t.mode === 'local') needLogin = true
      if (!uninstall && !o.dryRun && c.kind === 'codex' && t.mode === 'remote' && t.cli) codexLogin = true
    } catch (e) {
      failed = true
      results.push({ t, result: `failed: ${e instanceof Error ? e.message : String(e)}`, next: manualSteps(t, env, uninstall) })
    }
  }
  asker?.close()

  if (results.length) {
    say()
    say(o.dryRun ? 'Would do:' : 'Result:')
    for (const r of results) {
      say(`  ${r.t.client.name}: ${r.result}`)
      if (r.next) say(`    next: ${r.next}`)
    }
  }
  if (backups.length) {
    say()
    say('Backups (copy one back over the file to undo):')
    for (const b of backups) say(`  ${tilde(env, b)}`)
  }

  if (!o.dryRun && !uninstall) {
    if (codexLogin) {
      if (o.login) {
        say()
        say('Signing Codex in to apimodels (codex mcp login apimodels)…')
        const r = run('codex', ['mcp', 'login', NAME], true)
        if (!r.ok) say(`Codex sign-in did not finish${r.out ? ` (${r.out})` : ''}. Run it later: codex mcp login apimodels`)
      } else say('\nCodex: run `codex mcp login apimodels` to sign in.')
    }
    if (needLogin && !hasSavedKey()) {
      if (o.login) {
        say()
        say('The local server needs an apimodels key on this machine. Signing in once (apimodels-mcp login)…')
        const code = await runCli('login', [], baseUrl)
        if (code !== 0) { failed = true; say('Sign-in did not finish. Run it later: npx -y apimodels-mcp login') }
      } else say('\nThe local server needs a key on this machine: run `npx -y apimodels-mcp login` once.')
    }
  }
  if (uninstall && !o.dryRun && results.some((r) => /^removed/.test(r.result)) && hasSavedKey()) {
    say('\nThe key saved by `apimodels-mcp login` is still on this machine; `npx -y apimodels-mcp logout` removes it.')
  }

  if (!uninstall && (!o.clients || o.clients.includes('workbuddy'))) { say(); say(MANUAL_GUI) }
  if (o.dryRun) { say(); say('Dry run: nothing was written.') }
  return failed ? 1 : 0
}

// ─── applying one change ────────────────────────────────────────────────────

function applyJson(c: JsonClient, t: Target, env: Env, o: Opts, uninstall: boolean, backups: string[]): string {
  const file = t.where
  const raw = readText(file)
  const bom = raw !== null && raw.charCodeAt(0) === 0xfeff
  const before = raw === null ? null : stripBom(raw)
  const entry = c.entry(t.mode)
  let after: string
  let expected: unknown
  if (uninstall) {
    if (before === null) return 'nothing to remove'
    const next = removeMember(before, c.path, NAME)
    if (next === null) return 'nothing to remove'
    after = next
    expected = structuredClone(toValue(parseJsonc(before)))
    let box = expected as Record<string, unknown>
    for (const seg of c.path) box = box[seg] as Record<string, unknown>
    delete box[NAME]
  } else if (before === null || !before.trim()) {
    expected = c.newFile ? c.newFile(entry) : nest(c.path, entry)
    after = JSON.stringify(expected, null, 2) + '\n'
  } else {
    after = setMember(before, c.path, NAME, entry)
    expected = structuredClone(toValue(parseJsonc(before)))
    let box = expected as Record<string, unknown>
    for (const seg of c.path) { if (!isObj(box[seg])) box[seg] = {}; box = box[seg] as Record<string, unknown> }
    box[NAME] = entry
  }
  // The edit must parse back to exactly the intended value, or the file is not touched.
  const got = JSON.stringify(toValue(parseJsonc(after)))
  if (got !== JSON.stringify(expected)) throw new Error(`the edited ${tilde(env, file)} would not read back as intended; left unchanged`)
  if (before !== null && after === before) return 'already set up, unchanged'

  const created = before === null || !before.trim()
  const verb = uninstall ? 'removed' : t.state.status === 'different' ? 'replaced' : 'added'
  if (o.dryRun) { say(`${c.name}:`); say(diff(before, after, tilde(env, file))); say(); return `would be ${verb}` }
  const b = backup(file)
  if (b) backups.push(b)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, (bom ? '\uFEFF' : '') + after)
  if (uninstall) return `removed from ${tilde(env, file)}`
  return `${verb} (${t.mode === 'remote' ? 'hosted' : 'local'}${created ? ', new file' : ''}) in ${tilde(env, file)}`
}

function nest(path: string[], entry: Entry): unknown {
  let v: unknown = { [NAME]: entry }
  for (const seg of [...path].reverse()) v = { [seg]: v }
  return v
}

function applyClaude(t: Target, env: Env, o: Opts, uninstall: boolean, replacing: boolean, backups: string[]): string {
  const add = t.mode === 'remote'
    ? ['mcp', 'add', '--transport', 'http', '--scope', 'user', NAME, REMOTE_URL]
    : ['mcp', 'add', '--scope', 'user', NAME, '--', LOCAL.command, ...LOCAL.args]
  const remove = ['mcp', 'remove', NAME, '--scope', 'user']
  const steps = uninstall ? [remove] : replacing ? [remove, add] : [add]
  if (o.dryRun) {
    say('Claude Code:')
    for (const s of steps) say(`    $ claude ${s.join(' ')}`)
    say()
    return `would be ${uninstall ? 'removed' : replacing ? 'replaced' : 'added'}`
  }
  const b = backup(env.claudeJson)
  if (b) backups.push(b)
  for (const s of steps) {
    const r = run('claude', s)
    if (!r.ok) throw new Error(`claude ${s.join(' ')} failed${r.out ? `: ${r.out}` : ''}`)
  }
  const now = claudeState(env, t.mode).status
  if (uninstall ? now !== 'absent' : now !== 'same') throw new Error(`the claude CLI reported success but ${tilde(env, env.claudeJson)} does not show the change`)
  return `${uninstall ? 'removed' : replacing ? 'replaced' : 'added'} with \`claude ${steps[steps.length - 1].join(' ')}\``
}

function applyCodex(t: Target, env: Env, o: Opts, uninstall: boolean, replacing: boolean, backups: string[]): string {
  const file = codexFile(env)
  const entry: CodexEntry = t.mode === 'remote' ? { url: REMOTE_URL } : { command: LOCAL.command, args: LOCAL.args }
  if (t.cli) {
    const add = t.mode === 'remote' ? ['mcp', 'add', NAME, '--url', REMOTE_URL] : ['mcp', 'add', NAME, '--', LOCAL.command, ...LOCAL.args]
    const remove = ['mcp', 'remove', NAME]
    const steps = uninstall ? [remove] : replacing ? [remove, add] : [add]
    if (o.dryRun) {
      say('Codex:')
      for (const s of steps) say(`    $ codex ${s.join(' ')}`)
      say()
      return `would be ${uninstall ? 'removed' : replacing ? 'replaced' : 'added'}`
    }
    const b = backup(file)
    if (b) backups.push(b)
    for (const s of steps) {
      const r = run('codex', s)
      if (!r.ok) throw new Error(`codex ${s.join(' ')} failed${r.out ? `: ${r.out}` : ''}`)
    }
    const now = codexState(env, t.mode).status
    if (uninstall ? now !== 'absent' : now !== 'same') throw new Error(`the codex CLI reported success but ${tilde(env, file)} does not show the change`)
    return `${uninstall ? 'removed' : replacing ? 'replaced' : 'added'} with \`codex ${steps[steps.length - 1].join(' ')}\``
  }
  // No codex command (desktop app / IDE extension only): edit config.toml ourselves.
  const before = readText(file)
  let after: string
  if (uninstall) {
    const f = before === null ? { kind: 'none' as const } : findCodexServer(before, NAME)
    if (f.kind !== 'table') return 'nothing to remove'
    after = removeCodexServer(before!, f)
  } else {
    let base = before ?? ''
    if (replacing) {
      const f = findCodexServer(base, NAME)
      if (f.kind !== 'table') throw new Error('existing entry not found')
      base = removeCodexServer(base, f)
    }
    after = appendCodexServer(base, NAME, entry)
  }
  const check = findCodexServer(after, NAME)
  const ok = uninstall ? check.kind === 'none' : check.kind === 'table' && (t.mode === 'remote' ? check.values.url === REMOTE_URL : check.values.command === LOCAL.command)
  if (!ok) throw new Error(`the edited ${tilde(env, file)} would not read back as intended; left unchanged`)
  const verb = uninstall ? 'removed' : replacing ? 'replaced' : before === null ? 'added (new file)' : 'added'
  if (o.dryRun) { say('Codex:'); say(diff(before, after, tilde(env, file))); say(); return `would be ${verb}` }
  const b = backup(file)
  if (b) backups.push(b)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, after)
  return `${verb} in ${tilde(env, file)}`
}

function manualSteps(t: Target, env: Env, uninstall: boolean): string {
  const c = t.client
  if (c.kind === 'claude') {
    return uninstall ? 'claude mcp remove apimodels --scope user'
      : t.mode === 'remote' ? `claude mcp add --transport http --scope user apimodels ${REMOTE_URL}` : `claude mcp add --scope user apimodels -- ${LOCAL_CMD}`
  }
  if (c.kind === 'codex') {
    return uninstall ? `delete the [mcp_servers.apimodels] table from ${tilde(env, codexFile(env))}`
      : `add to ${tilde(env, codexFile(env))}:  [mcp_servers.apimodels]  ${t.mode === 'remote' ? `url = "${REMOTE_URL}"` : `command = "npx"  args = ["-y", "apimodels-mcp"]`}`
  }
  const where = `${tilde(env, t.where)} → ${[...c.path, NAME].join(' → ')}`
  return uninstall ? `delete ${where}` : `edit by hand: ${where} = ${JSON.stringify(c.entry(t.mode))}`
}

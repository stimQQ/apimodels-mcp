/**
 * Offline test for `apimodels-mcp install` / `uninstall` (0.10.0).
 *
 * Every run happens in a FAKE home: a fresh temp directory passed as HOME / USERPROFILE /
 * APPDATA / XDG_CONFIG_HOME, with a hand-built environment (nothing inherited from this shell)
 * and a PATH that holds only stand-in `claude` / `codex` scripts plus /usr/bin:/bin. The real
 * home directory and the real claude / codex / gemini commands are never reachable; the test
 * refuses to start if they could be. It seeds each client's config with other servers,
 * comments, trailing commas, tabs and CRLF, then checks: the merge, that nothing else in the
 * file changed, the backups, that a second run changes nothing, that --dry-run writes nothing,
 * that a different existing entry is kept unless replacing is confirmed, and that uninstall
 * gives back the original bytes.
 *
 *   pnpm build && node scripts/install-test.mjs
 *   INSTALL_TEST_ENTRY=path/to/index.js node scripts/install-test.mjs   (scripts/install-mutations.mjs)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, chmodSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(process.env.INSTALL_TEST_ENTRY || join(here, '..', 'dist', 'index.js'))
const URL = 'https://api.apimodels.app/mcp'
const QUIET = process.env.INSTALL_TEST_QUIET === '1'

let bad = 0
const ok = (name, cond, detail = '') => {
  if (!cond) bad++
  if (!QUIET || !cond) console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  <- ' + String(detail).slice(0, 1500)}`)
}
const section = (s) => { if (!QUIET) console.log(`\n— ${s} —`) }

// ── safety: a fake home far away from the real one, no real client CLIs on PATH ──
const REAL_HOME = realpathSync(homedir())
const root = realpathSync(mkdtempSync(join(tmpdir(), 'apimodels-install-test-')))
const SYS_PATH = ['/usr/bin', '/bin']
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
if (root === REAL_HOME || root.startsWith(REAL_HOME + '/') || REAL_HOME.startsWith(root)) throw new Error(`refusing to run: temp dir ${root} overlaps the real home ${REAL_HOME}`)
for (const d of SYS_PATH) for (const c of ['claude', 'codex', 'gemini', 'opencode']) {
  if (existsSync(join(d, c))) throw new Error(`refusing to run: a real ${c} is in ${d}, which the test puts on PATH`)
}

// ── stand-in claude / codex: log argv, emulate the config change the real CLI makes ──
const shimDir = join(root, 'bin')
mkdirSync(shimDir)
const shimJs = join(root, 'shim.mjs')
writeFileSync(shimJs, `
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
const [tool, ...a] = process.argv.slice(2)
appendFileSync(process.env.SHIM_LOG, JSON.stringify([tool, ...a]) + '\\n')
const home = process.env.HOME
if (tool === 'claude') {
  const file = join(home, '.claude.json')
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const scope = a.includes('--scope') ? a[a.indexOf('--scope') + 1] : 'local'
  if (scope !== 'user') { console.error('shim: only user scope is emulated'); process.exit(3) }
  if (a[0] === 'mcp' && a[1] === 'add') {
    const dd = a.indexOf('--')
    const head = a.slice(2, dd < 0 ? a.length : dd)
    const pos = head.filter((x, k) => !x.startsWith('--') && !['--transport', '--scope'].includes(head[k - 1]))
    const name = pos[0]
    const entry = head.includes('--transport') ? { type: head[head.indexOf('--transport') + 1], url: pos[1] } : { type: 'stdio', command: a[dd + 1], args: a.slice(dd + 2), env: {} }
    j.mcpServers ??= {}
    if (j.mcpServers[name]) { console.error('MCP server ' + name + ' already exists in user config'); process.exit(1) }
    j.mcpServers[name] = entry
  } else if (a[0] === 'mcp' && a[1] === 'remove') {
    if (!j.mcpServers?.[a[2]]) { console.error('No MCP server named ' + a[2]); process.exit(1) }
    delete j.mcpServers[a[2]]
  } else process.exit(2)
  writeFileSync(file, JSON.stringify(j, null, 2))
  console.log('ok')
}
if (tool === 'codex') {
  const file = join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml')
  let t = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const strip = (name) => {
    const ls = t.split('\\n'); const i = ls.indexOf('[mcp_servers.' + name + ']')
    if (i < 0) return false
    let e = i + 1; while (e < ls.length && !ls[e].startsWith('[')) e++
    while (e - 1 > i && ls[e - 1] === '') e--
    const s = i > 0 && ls[i - 1] === '' ? i - 1 : i
    ls.splice(s, e - s); t = ls.join('\\n'); return true
  }
  if (a[0] === 'mcp' && a[1] === 'add') {
    const name = a[2]; strip(name)
    const dd = a.indexOf('--')
    const body = a.includes('--url') ? 'url = "' + a[a.indexOf('--url') + 1] + '"\\n' : 'command = "' + a[dd + 1] + '"\\nargs = ' + JSON.stringify(a.slice(dd + 2)) + '\\n'
    t = (t && !t.endsWith('\\n') ? t + '\\n' : t) + (t.trim() ? '\\n' : '') + '[mcp_servers.' + name + ']\\n' + body
  } else if (a[0] === 'mcp' && a[1] === 'remove') {
    if (!strip(a[2])) { console.error('No MCP server named ' + a[2]); process.exit(1) }
  } else if (a[0] === 'mcp' && a[1] === 'login') { console.log('pretend login'); process.exit(0) }
  else process.exit(2)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, t)
}
`)
for (const name of ['claude', 'codex']) {
  writeFileSync(join(shimDir, name), `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" ${name} "$@"\n`)
  chmodSync(join(shimDir, name), 0o755)
}

// ── fake homes ──
let homeN = 0
function newHome(label) {
  const h = join(root, `home-${++homeN}-${label}`)
  mkdirSync(h, { recursive: true })
  return h
}
function put(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)

/** Run the CLI in a fake home. Nothing from this process's environment leaks in. */
function cli(home, args, { platform = 'darwin', input = '', shims = true, env = {} } = {}) {
  if (!home.startsWith(root + '/')) throw new Error('refusing to run outside the temp root')
  const e = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: [...(shims ? [shimDir] : []), ...SYS_PATH].join(':'),
    SHIM_LOG: join(home, 'shim.log'),
    APIMODELS_INSTALL_PLATFORM: platform,
    APIMODELS_SITE_URL: 'http://127.0.0.1:9', // a login attempt could never reach the real site
    APIMODELS_BASE_URL: 'http://127.0.0.1:9/v1',
    ...env,
  }
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
  const r = spawnSync(process.execPath, [ENTRY, ...args], { env: e, input, encoding: 'utf8', timeout: 60_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

/** Every file under home (relative path → content), without the shim log. */
function snapshot(home) {
  const out = {}
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n !== 'shim.log') out[relative(home, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(home)
  return out
}
const backupsIn = (snap) => Object.keys(snap).filter((k) => k.includes('.apimodels-backup-'))
const shimLog = (home) => (read(join(home, 'shim.log')) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const changedKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])

/** JSONC → value, independently of the code under test (strip comments + trailing commas). */
function jsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { const s = i; i++; while (text[i] !== '"') { if (text[i] === '\\') i++; i++ } out += text.slice(s, i + 1); continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 1; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

// ── seeds: each client's config with other servers, comments and odd formatting ──
const LIB = (h, ...p) => join(h, 'Library', 'Application Support', ...p)
const P = {
  claudeJson: (h) => join(h, '.claude.json'),
  codex: (h) => join(h, '.codex', 'config.toml'),
  desktop: (h) => LIB(h, 'Claude', 'claude_desktop_config.json'),
  cursor: (h) => join(h, '.cursor', 'mcp.json'),
  vscode: (h) => LIB(h, 'Code', 'User', 'mcp.json'),
  devin: (h) => join(h, '.config', 'devin', 'mcp_config.json'),
  gemini: (h) => join(h, '.gemini', 'settings.json'),
  opencode: (h) => join(h, '.config', 'opencode', 'opencode.jsonc'),
}
const SEED = {
  claudeJson: JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'other-mcp', args: [], env: {} } }, projects: {} }, null, 2),
  codex: '# my Codex settings\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.other]\ncommand = "other-mcp"  # keep me\n\n[profiles.fast]\nmodel = "gpt-6.1-luna"\n',
  desktop: '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop"]\n    }\n  },\n  "preferences": { "quickEntryShortcut": "off" }\n}\n',
  cursor: '{\n  // servers I use every day\n  "mcpServers": {\n    "github": { "url": "https://api.githubcopilot.com/mcp/" }, // work account\n  },\n}\n',
  vscode: '{\n\t// VS Code user MCP config (tabs on purpose)\n\t"servers": {\n\t\t"fetch": {\n\t\t\t"type": "stdio",\n\t\t\t"command": "uvx",\n\t\t\t"args": ["mcp-server-fetch"]\n\t\t}\n\t},\n\t"inputs": []\n}\n',
  devin: '{\n  "mcpServers": {\n    "notion": {\n      "url": "https://mcp.notion.com/mcp",\n      "transport": "http"\n    } /* added by hand */\n  }\n}\n',
  gemini: '{\r\n  "theme": "Default",\r\n  /* keep this */\r\n  "mcpServers": {}\r\n}\r\n',
  opencode: '{\n  "$schema": "https://opencode.ai/config.json",\n  // my model\n  "model": "anthropic/claude-sonnet-5-5"\n}\n',
}
function seedAll(h, { creds = true } = {}) {
  for (const k of Object.keys(SEED)) put(P[k](h), SEED[k])
  mkdirSync(join(h, '.claude'), { recursive: true })
  if (creds) put(join(h, '.apimodels', 'credentials.json'), JSON.stringify({ api_key: 'sk_seeded_test_key' }))
}

const CURSOR_AFTER = '{\n  // servers I use every day\n  "mcpServers": {\n    "github": { "url": "https://api.githubcopilot.com/mcp/" }, // work account\n    "apimodels": {\n      "url": "https://api.apimodels.app/mcp"\n    },\n  },\n}\n'
const VSCODE_AFTER = '{\n\t// VS Code user MCP config (tabs on purpose)\n\t"servers": {\n\t\t"fetch": {\n\t\t\t"type": "stdio",\n\t\t\t"command": "uvx",\n\t\t\t"args": ["mcp-server-fetch"]\n\t\t},\n\t\t"apimodels": {\n\t\t\t"type": "http",\n\t\t\t"url": "https://api.apimodels.app/mcp"\n\t\t}\n\t},\n\t"inputs": []\n}\n'
const CODEX_TEXT_AFTER = SEED.codex + '\n[mcp_servers.apimodels]\nurl = "https://api.apimodels.app/mcp"\n'

// ════════════════════════════════════════════════════════════════════════════
section('dry run writes nothing')
const H = newHome('main')
seedAll(H)
const seeded = snapshot(H)
let r = cli(H, ['install', '--dry-run'])
ok('exit 0', r.code === 0, r.out)
ok('no file changed, no backup written', sameSnap(snapshot(H), seeded), changedKeys(snapshot(H), seeded))
ok('claude / codex never invoked', shimLog(H).length === 0, JSON.stringify(shimLog(H)))
ok('prints the exact claude command', r.out.includes(`$ claude mcp add --transport http --scope user apimodels ${URL}`), r.out)
ok('prints the exact codex command', r.out.includes(`$ codex mcp add apimodels --url ${URL}`), r.out)
ok('prints a diff for Cursor with the added lines', r.out.includes('+     "apimodels": {') && r.out.includes('~/.cursor/mcp.json'), r.out)
ok('found all 8 clients', /Found 8 MCP clients/.test(r.out), r.out)

section('install --yes')
r = cli(H, ['install', '--yes', '--no-login'])
const after1 = snapshot(H)
ok('exit 0', r.code === 0, r.out)
ok('Cursor: comments + trailing commas kept, entry added, exact bytes', read(P.cursor(H)) === CURSOR_AFTER, JSON.stringify(read(P.cursor(H))))
ok('VS Code: tabs kept, {type:http,url} under "servers", exact bytes', read(P.vscode(H)) === VSCODE_AFTER, JSON.stringify(read(P.vscode(H))))
const desk = jsonc(read(P.desktop(H)))
ok('Claude Desktop: local stdio entry (no key in it), other server + preferences kept',
  JSON.stringify(desk.mcpServers.apimodels) === JSON.stringify({ command: 'npx', args: ['-y', 'apimodels-mcp'] }) && desk.mcpServers.filesystem.args.length === 3 && desk.preferences.quickEntryShortcut === 'off', read(P.desktop(H)))
const dv = read(P.devin(H))
ok('Windsurf / Devin: {url} added, block comment + notion kept', jsonc(dv).mcpServers.apimodels.url === URL && dv.includes('/* added by hand */') && jsonc(dv).mcpServers.notion.transport === 'http', dv)
const gm = read(P.gemini(H))
ok('Gemini CLI: {httpUrl} in the empty mcpServers, comment kept', jsonc(gm).mcpServers.apimodels.httpUrl === URL && gm.includes('/* keep this */') && jsonc(gm).theme === 'Default', gm)
ok('Gemini CLI: CRLF file stays CRLF only', !/[^\r]\n/.test(gm) && gm.includes('\r\n'), JSON.stringify(gm))
const oc = read(P.opencode(H))
ok('OpenCode: mcp.servers.apimodels = {type:remote,url} created in opencode.jsonc, comment kept',
  JSON.stringify(jsonc(oc).mcp.servers.apimodels) === JSON.stringify({ type: 'remote', url: URL }) && oc.includes('// my model') && jsonc(oc).$schema, oc)
const log1 = shimLog(H)
ok('Claude Code: claude mcp add --transport http --scope user apimodels <url>', JSON.stringify(log1.find((l) => l[0] === 'claude')) === JSON.stringify(['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'apimodels', URL]), JSON.stringify(log1))
ok('Claude Code: ~/.claude.json now has it, other keys kept', (() => { const j = JSON.parse(read(P.claudeJson(H))); return j.mcpServers.apimodels.url === URL && j.mcpServers.other && j.numStartups === 7 })(), read(P.claudeJson(H)))
ok('Codex: codex mcp add apimodels --url <url>', JSON.stringify(log1.find((l) => l[0] === 'codex')) === JSON.stringify(['codex', 'mcp', 'add', 'apimodels', '--url', URL]), JSON.stringify(log1))
ok('Codex: --no-login → no codex mcp login, but the command is printed', !log1.some((l) => l[2] === 'login') && r.out.includes('codex mcp login apimodels'), r.out)
ok('Codex: config.toml keeps the comment and the other server', (() => { const t = read(P.codex(H)); return t.includes('# keep me') && t.includes('[mcp_servers.apimodels]') && t.includes('[profiles.fast]') })(), read(P.codex(H)))
const bk = backupsIn(after1)
for (const k of Object.keys(SEED)) {
  const rel = relative(H, P[k](H))
  const mine = bk.filter((b) => b.startsWith(rel + '.apimodels-backup-'))
  ok(`backup of ${rel}: exactly one, with the original bytes`, mine.length === 1 && after1[mine[0]] === SEED[k], JSON.stringify(mine))
}
ok('backup names carry a UTC timestamp', bk.every((b) => /\.apimodels-backup-\d{8}-\d{6}(-\d+)?$/.test(b)), JSON.stringify(bk))
ok('backups keep the original permissions', (() => { const b = bk.find((x) => x.startsWith('.claude.json.')); return (statSync(join(H, b)).mode & 0o777) === (statSync(P.claudeJson(H)).mode & 0o777) })())

section('second run is a no-op')
r = cli(H, ['install', '--yes', '--no-login'])
ok('exit 0', r.code === 0, r.out)
ok('no file changed, no new backup', sameSnap(snapshot(H), after1), changedKeys(snapshot(H), after1))
ok('claude / codex not invoked again', shimLog(H).length === log1.length, JSON.stringify(shimLog(H)))
ok('every client reports "already set up"', (r.out.match(/already set up, unchanged/g) ?? []).length === 8, r.out)

section('uninstall gives the original bytes back')
r = cli(H, ['uninstall', '--yes'])
ok('exit 0', r.code === 0, r.out)
for (const k of ['desktop', 'cursor', 'vscode', 'devin', 'gemini']) ok(`${k}: byte-identical to the seed`, read(P[k](H)) === SEED[k], JSON.stringify(read(P[k](H))))
const ocU = read(P.opencode(H))
ok('opencode: apimodels gone, comment + model kept (an empty mcp.servers stays)', !ocU.includes('apimodels') && ocU.includes('// my model') && jsonc(ocU).model === 'anthropic/claude-sonnet-5-5', ocU)
const log2 = shimLog(H).slice(log1.length)
ok('claude mcp remove apimodels --scope user', log2.some((l) => JSON.stringify(l) === JSON.stringify(['claude', 'mcp', 'remove', 'apimodels', '--scope', 'user'])), JSON.stringify(log2))
ok('codex mcp remove apimodels', log2.some((l) => JSON.stringify(l) === JSON.stringify(['codex', 'mcp', 'remove', 'apimodels'])), JSON.stringify(log2))
ok('~/.claude.json: apimodels gone, other server kept', (() => { const j = JSON.parse(read(P.claudeJson(H))); return !j.mcpServers.apimodels && j.mcpServers.other })())
ok('config.toml: back to the seed', read(P.codex(H)) === SEED.codex, JSON.stringify(read(P.codex(H))))
const after2 = snapshot(H)
ok('uninstall wrote a new backup per changed file (8 more)', backupsIn(after2).length === bk.length + 8, JSON.stringify(backupsIn(after2)))
r = cli(H, ['uninstall', '--yes'])
ok('uninstall again: nothing to remove, nothing changed', r.code === 0 && sameSnap(snapshot(H), after2) && (r.out.match(/nothing to remove/g) ?? []).length === 8, r.out)

section('interactive: answers per client, closed stdin stops')
const I = newHome('ask')
seedAll(I)
r = cli(I, ['install', '--client', 'cursor,vscode,gemini', '--no-login'], { input: 'n\ny\n' })
ok('exit 0', r.code === 0, r.out)
ok('Cursor declined → unchanged', read(P.cursor(I)) === SEED.cursor)
ok('VS Code accepted → added', read(P.vscode(I)) === VSCODE_AFTER, read(P.vscode(I)))
ok('Gemini: no answer left → unchanged, says so', read(P.gemini(I)) === SEED.gemini && r.out.includes('No answer (stdin closed)'), r.out)
const I2 = newHome('noanswer')
seedAll(I2)
const s2 = snapshot(I2)
r = cli(I2, ['install', '--no-login'], { input: '' })
ok('no --yes and nothing on stdin → nothing at all changes', r.code === 0 && sameSnap(snapshot(I2), s2) && shimLog(I2).length === 0, r.out)

section('an existing, different "apimodels" entry is kept unless replacing is confirmed')
const K = newHome('keep')
const OLD = '{\n  "mcpServers": {\n    // set up by hand last month\n    "apimodels": { "command": "npx", "args": ["-y", "apimodels-mcp"], "env": { "APIMODELS_API_KEY": "sk_old_key_123" } }\n  }\n}\n'
put(P.cursor(K), OLD)
r = cli(K, ['install', '--yes', '--client', 'cursor'])
ok('--yes alone keeps it, says how to replace', r.code === 0 && read(P.cursor(K)) === OLD && r.out.includes('--replace --client cursor'), r.out)
r = cli(K, ['install', '--client', 'cursor'], { input: '\n' })
ok('interactive: Enter = No for a replacement', read(P.cursor(K)) === OLD && /Replace it with .*\[y\/N\]/s.test(r.out), r.out)
ok('the old entry is shown with its key masked (sk_…_123)', r.out.includes('sk_…_123') && !r.out.includes('sk_old_key_123'), r.out)
r = cli(K, ['install', '--dry-run', '--replace', '--client', 'cursor'])
ok('--dry-run --replace: diff shown, key masked, file unchanged', r.out.includes('-     "apimodels": { "command": "npx"') && !r.out.includes('sk_old_key_123') && read(P.cursor(K)) === OLD, r.out)
r = cli(K, ['install', '--yes', '--replace', '--client', 'cursor'])
const kt = read(P.cursor(K))
ok('--replace swaps in the hosted entry, comment kept', jsonc(kt).mcpServers.apimodels.url === URL && !jsonc(kt).mcpServers.apimodels.env && kt.includes('// set up by hand last month'), kt)
const kb = backupsIn(snapshot(K))
ok('the backup holds the old entry with its key', kb.length === 1 && read(join(K, kb[0])) === OLD, JSON.stringify(kb))

section('a file that does not parse is left alone')
const B = newHome('broken')
const BROKEN = '{ "mcpServers": { "x": { "url": "u" },, } }\n'
put(P.cursor(B), BROKEN)
put(P.vscode(B), SEED.vscode)
r = cli(B, ['install', '--yes', '--client', 'cursor,vscode'])
ok('exit 1 (one client could not be done)', r.code === 1, r.out)
ok('broken Cursor file unchanged, no backup of it', read(P.cursor(B)) === BROKEN && !backupsIn(snapshot(B)).some((k) => k.startsWith('.cursor')), r.out)
ok('says why and what to add by hand', r.out.includes('cannot parse') && r.out.includes('edit by hand'), r.out)
ok('VS Code still done', read(P.vscode(B)) === VSCODE_AFTER)

section('OpenCode with servers directly under "mcp" (older layout) is not touched')
const O = newHome('opencode-v1')
const V1 = '{\n  "mcp": {\n    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }\n  }\n}\n'
put(join(O, '.config', 'opencode', 'opencode.json'), V1)
r = cli(O, ['install', '--yes', '--client', 'opencode'])
ok('unchanged, exit 1, explains the layout', r.code === 1 && read(join(O, '.config', 'opencode', 'opencode.json')) === V1 && r.out.includes('mcp.servers'), r.out)

section('no codex / claude command: Codex edited directly, Claude Code gets manual steps')
const C = newHome('nocli')
put(P.codex(C), SEED.codex)
put(P.claudeJson(C), SEED.claudeJson)
r = cli(C, ['install', '--yes', '--client', 'codex,claude-code', '--no-login'], { shims: false })
ok('exit 0', r.code === 0, r.out)
ok('config.toml = seed + one blank line + the table', read(P.codex(C)) === CODEX_TEXT_AFTER, JSON.stringify(read(P.codex(C))))
ok('~/.claude.json untouched, exact claude command printed', read(P.claudeJson(C)) === SEED.claudeJson && r.out.includes(`claude mcp add --transport http --scope user apimodels ${URL}`), r.out)
const cs = snapshot(C)
r = cli(C, ['install', '--yes', '--client', 'codex', '--no-login'], { shims: false })
ok('second run: no change', sameSnap(snapshot(C), cs), changedKeys(snapshot(C), cs))
r = cli(C, ['uninstall', '--yes', '--client', 'codex'], { shims: false })
ok('uninstall: config.toml byte-identical to the seed', read(P.codex(C)) === SEED.codex, JSON.stringify(read(P.codex(C))))

section('empty machine, and a client named explicitly')
const E = newHome('empty')
r = cli(E, ['install', '--yes'], { shims: false })
ok('nothing found, nothing created', r.code === 0 && /No MCP clients found/.test(r.out) && Object.keys(snapshot(E)).length === 0, r.out)
r = cli(E, ['install', '--yes', '--client', 'cursor'])
const NEW_CURSOR = `{\n  "mcpServers": {\n    "apimodels": {\n      "url": "${URL}"\n    }\n  }\n}\n`
ok('--client cursor creates ~/.cursor/mcp.json', read(P.cursor(E)) === NEW_CURSOR, read(P.cursor(E)))
r = cli(E, ['uninstall', '--yes', '--client', 'cursor'])
ok('uninstall leaves an empty mcpServers', read(P.cursor(E)) === '{\n  "mcpServers": {}\n}\n', JSON.stringify(read(P.cursor(E))))
r = cli(E, ['install', '--client', 'nope'])
ok('unknown client → exit 2 with the list', r.code === 2 && r.out.includes('Known: claude-code'), r.out)

section('Linux paths ($XDG_CONFIG_HOME)')
const L = newHome('linux')
const xdg = join(L, 'xdg')
for (const d of ['Claude', 'Code/User', 'devin', 'opencode']) mkdirSync(join(xdg, d), { recursive: true })
r = cli(L, ['install', '--yes', '--no-login'], { platform: 'linux', env: { XDG_CONFIG_HOME: xdg } })
ok('exit 0', r.code === 0, r.out)
for (const f of ['Claude/claude_desktop_config.json', 'Code/User/mcp.json', 'devin/mcp_config.json', 'opencode/opencode.json']) ok(`written to $XDG_CONFIG_HOME/${f}`, (read(join(xdg, f)) ?? '').includes('apimodels'), r.out)
ok('nothing under ~/.config or ~/Library', !existsSync(join(L, '.config')) && !existsSync(join(L, 'Library')))

section('Windows paths (%APPDATA%, %USERPROFILE%)')
const W = newHome('windows')
const appData = join(W, 'Roaming-custom')
for (const d of ['Claude', 'Code/User', 'devin']) mkdirSync(join(appData, d), { recursive: true })
mkdirSync(join(W, '.cursor'), { recursive: true })
const BOM_DESKTOP = '\uFEFF{\r\n  "mcpServers": {}\r\n}\r\n' // Notepad on Windows saves a BOM
put(join(appData, 'Claude', 'claude_desktop_config.json'), BOM_DESKTOP)
mkdirSync(join(W, '.config', 'opencode'), { recursive: true })
r = cli(W, ['install', '--yes', '--no-login'], { platform: 'win32', env: { APPDATA: appData, XDG_CONFIG_HOME: undefined } })
ok('exit 0', r.code === 0, r.out)
for (const f of ['Claude/claude_desktop_config.json', 'Code/User/mcp.json', 'devin/mcp_config.json']) ok(`written to %APPDATA%\\${f}`, (read(join(appData, f)) ?? '').includes('apimodels'), r.out)
ok('Cursor in %USERPROFILE%\\.cursor, OpenCode in %USERPROFILE%\\.config\\opencode', (read(join(W, '.cursor', 'mcp.json')) ?? '').includes(URL) && (read(join(W, '.config', 'opencode', 'opencode.json')) ?? '').includes(URL), r.out)
ok('nothing under the default AppData\\Roaming', !existsSync(join(W, 'AppData')))
const bomAfter = read(join(appData, 'Claude', 'claude_desktop_config.json'))
ok('a BOM at the start of the file is kept, CRLF kept', bomAfter.startsWith('\uFEFF{\r\n') && jsonc(bomAfter.slice(1)).mcpServers.apimodels.command === 'npx' && !/[^\r]\n/.test(bomAfter), JSON.stringify(bomAfter))

section('--local: the stdio server everywhere')
const Lo = newHome('local')
for (const k of ['cursor', 'vscode', 'opencode', 'claudeJson']) put(P[k](Lo), SEED[k])
r = cli(Lo, ['install', '--yes', '--local', '--no-login', '--client', 'cursor,vscode,opencode,claude-code'])
ok('exit 0', r.code === 0, r.out)
ok('Cursor: {command:npx,args}', JSON.stringify(jsonc(read(P.cursor(Lo))).mcpServers.apimodels) === '{"command":"npx","args":["-y","apimodels-mcp"]}', read(P.cursor(Lo)))
ok('VS Code: {type:stdio,…}', JSON.stringify(jsonc(read(P.vscode(Lo))).servers.apimodels) === '{"type":"stdio","command":"npx","args":["-y","apimodels-mcp"]}', read(P.vscode(Lo)))
ok('OpenCode: {type:local,command:[…]}', JSON.stringify(jsonc(read(P.opencode(Lo))).mcp.servers.apimodels) === '{"type":"local","command":["npx","-y","apimodels-mcp"]}', read(P.opencode(Lo)))
ok('Claude Code: claude mcp add --scope user apimodels -- npx -y apimodels-mcp', shimLog(Lo).some((l) => JSON.stringify(l) === JSON.stringify(['claude', 'mcp', 'add', '--scope', 'user', 'apimodels', '--', 'npx', '-y', 'apimodels-mcp'])), JSON.stringify(shimLog(Lo)))
ok('no saved key + --no-login → tells you to run apimodels-mcp login', r.out.includes('npx -y apimodels-mcp login'), r.out)
r = cli(Lo, ['install', '--yes', '--no-login', '--client', 'cursor'])
ok('hosted install afterwards keeps the local entry (it differs) unless --replace', jsonc(read(P.cursor(Lo))).mcpServers.apimodels.command === 'npx' && r.out.includes('kept the existing'), r.out)

console.log(bad ? `\n${bad} FAILED` : '\ninstall tests: all passed')
process.exit(bad ? 1 : 0)

/**
 * Mutation test for scripts/install-test.mjs: break the installer on purpose, one way at a time,
 * and check that the test suite goes red for every break. A mutant that survives means the tests
 * would not notice that bug in real life.
 *
 * Works on a copy of dist/ in .mut/ (inside the package, so node_modules still resolves),
 * runs the installer test against it, and removes the copy afterwards.
 *
 *   pnpm build && node scripts/install-mutations.mjs
 */
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const MUT = join(pkg, '.mut')

const MUTATIONS = [
  {
    id: 'merge-overwrites-file',
    what: 'write a fresh file with only our entry instead of merging (and skip the read-back check)',
    edits: [
      ['install.js', 'after = setMember(before, c.path, NAME, entry);', "after = JSON.stringify(nest(c.path, entry), null, 2) + '\\n';"],
      ['install.js', 'if (got !== JSON.stringify(expected))', 'if (false)'],
    ],
  },
  {
    id: 'merge-loses-comments',
    what: 'merge by JSON.parse + JSON.stringify (same values, comments and layout gone)',
    edits: [['install.js', 'after = setMember(before, c.path, NAME, entry);', "after = JSON.stringify(toValue(parseJsonc(setMember(before, c.path, NAME, entry))), null, 2) + '\\n';"]],
  },
  {
    id: 'insert-drops-comma',
    what: 'forget the comma after the previous last member',
    edits: [['jsonc.js', "{ start: last.value.end, end: last.value.end, text: ',' },", '']],
  },
  {
    id: 'insert-drops-comma-unchecked',
    what: 'forget the comma and skip the read-back check (broken JSON gets written)',
    edits: [
      ['jsonc.js', "{ start: last.value.end, end: last.value.end, text: ',' },", ''],
      ['install.js', 'if (got !== JSON.stringify(expected))', 'if (false)'],
    ],
  },
  {
    id: 'no-backup',
    what: 'never write a backup',
    edits: [['install.js', 'function backup(file) {\n    if (!existsSync(file))', 'function backup(file) {\n    if (true)']],
  },
  {
    id: 'backup-after-write',
    what: 'take the backup after writing (it then holds the new content)',
    edits: [['install.js',
      "const b = backup(file);\n    if (b)\n        backups.push(b);\n    mkdirSync(dirname(file), { recursive: true });\n    writeFileSync(file, (bom ? '\\uFEFF' : '') + after);",
      "mkdirSync(dirname(file), { recursive: true });\n    writeFileSync(file, (bom ? '\\uFEFF' : '') + after);\n    const b = backup(file);\n    if (b)\n        backups.push(b);"]],
  },
  {
    id: 'rewrite-when-unchanged',
    what: 'treat a present entry as missing and rewrite even when nothing changes (not idempotent)',
    edits: [
      ['install.js', "if (!hit.found)\n            return { status: 'absent' };", "return { status: 'absent' };"],
      ['install.js', 'if (before !== null && after === before)', 'if (false)'],
    ],
  },
  {
    id: 'dry-run-writes',
    what: '--dry-run writes the JSON files anyway',
    edits: [['install.js', 'if (o.dryRun) {\n        say(`${c.name}:`);\n        say(diff(before, after, tilde(env, file)));', 'if (false) {\n        say(`${c.name}:`);\n        say(diff(before, after, tilde(env, file)));']],
  },
  {
    id: 'replace-without-confirmation',
    what: 'replace a different existing "apimodels" entry under --yes without --replace',
    edits: [['install.js', 'if (replacing && !o.replace && (o.yes || o.dryRun)) {', 'if (false) {']],
  },
  {
    id: 'closed-stdin-means-yes',
    what: 'treat "no answer" (stdin closed) as yes',
    edits: [['install.js', 'if (line === null) {\n            say();\n            return null;', 'if (line === null) {\n            say();\n            return true;']],
  },
  {
    id: 'uninstall-noop',
    what: 'uninstall does not remove anything',
    edits: [['jsonc.js', 'return hit ? applyEdits(text, removeEdits(text, obj, hit.index)) : null;', 'return hit ? text : null;']],
  },
  {
    id: 'uninstall-leaves-comma',
    what: 'uninstall leaves the comma it added behind the previous member',
    edits: [['jsonc.js', "edits.push({ start: prev.comma, end: prev.comma + 1, text: '' });", '']],
  },
  {
    id: 'claude-wrong-scope',
    what: 'claude mcp add with --scope local instead of user',
    edits: [['install.js', "['mcp', 'add', '--transport', 'http', '--scope', 'user', NAME, REMOTE_URL]", "['mcp', 'add', '--transport', 'http', '--scope', 'local', NAME, REMOTE_URL]"]],
  },
  {
    id: 'toml-remove-keeps-blank',
    what: 'Codex text fallback: uninstall leaves the blank line it added',
    edits: [['toml-lite.js', 'if (blank && start > 0)', 'if (false)']],
  },
  {
    id: 'windows-ignores-appdata',
    what: 'Windows: ignore %APPDATA% and assume ~/AppData/Roaming',
    edits: [['install.js', "appData: process.env.APPDATA || join(home, 'AppData', 'Roaming'),", "appData: join(home, 'AppData', 'Roaming'),"]],
  },
  {
    id: 'linux-ignores-xdg',
    what: 'Linux: ignore $XDG_CONFIG_HOME',
    edits: [['install.js', "xdgConfig: process.env.XDG_CONFIG_HOME || join(home, '.config'),", "xdgConfig: join(home, '.config'),"]],
  },
  {
    id: 'dir-only-detection',
    what: 'back to "the folder exists = the client is installed" (skills/ folders, leftover profiles count)',
    edits: [['install.js', "return { strong: null, weak: dirs.length ? dirs.join(', ') : null };", "return { strong: dirs.length ? dirs.join(', ') : null, weak: null };"]],
  },
  {
    id: 'leftovers-configured-under-yes',
    what: '--yes also configures clients that only have a leftover folder',
    edits: [['install.js', 'const targets = all.filter((t) => o.clients || t.detection.strong);', 'const targets = all.filter((t) => o.clients || t.detection.strong || t.detection.weak);']],
  },
  {
    id: 'opencode-guard-off',
    what: 'OpenCode: edit an older-layout config instead of refusing',
    edits: [['install.js', 'const g = c.guard?.(toValue(root));', 'const g = null;']],
  },
]

function runSuite() {
  const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'install-test.mjs')], {
    env: { ...process.env, INSTALL_TEST_ENTRY: join(MUT, 'dist', 'index.js'), INSTALL_TEST_QUIET: '1' },
    encoding: 'utf8',
    timeout: 300_000,
  })
  const failed = (r.stdout.match(/^\s+FAIL /gm) ?? []).length
  const crashed = !/FAILED|all passed/.test(r.stdout) // an assertion threw on the broken output
  const first = /FAIL (.*?)(?:  <-|$)/m.exec(r.stdout)?.[1]?.trim()
  return { code: r.status, failed, crashed, first, out: r.stdout + r.stderr }
}

function fresh() {
  rmSync(MUT, { recursive: true, force: true })
  cpSync(join(pkg, 'dist'), join(MUT, 'dist'), { recursive: true })
}

let survivors = 0
try {
  fresh()
  const base = runSuite()
  if (base.code !== 0) { console.log('Unmutated copy does not pass; fix that first.\n' + base.out); process.exit(1) }
  console.log('baseline (unmutated copy): green\n')
  for (const m of MUTATIONS) {
    fresh()
    for (const [file, find, replace] of m.edits) {
      const p = join(MUT, 'dist', file)
      const src = readFileSync(p, 'utf8')
      const n = src.split(find).length - 1
      if (n !== 1) throw new Error(`${m.id}: expected the target once in ${file}, found ${n}: ${find}`)
      writeFileSync(p, src.replace(find, () => replace))
    }
    const r = runSuite()
    const killed = r.code !== 0
    if (!killed) survivors++
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${m.id.padEnd(30)} ${killed ? `${r.failed} check(s) red${r.crashed ? ', then the suite stopped' : ''}, first: "${r.first}"` : ''}`)
    console.log(`         ${m.what}`)
  }
} finally {
  rmSync(MUT, { recursive: true, force: true })
}
console.log(survivors ? `\n${survivors} mutant(s) survived` : `\nall ${MUTATIONS.length} mutants killed`)
process.exit(survivors ? 1 : 0)

/**
 * Just enough TOML to find, add and remove one `[mcp_servers.<name>]` table in Codex's
 * config.toml without disturbing anything else in the file (0.10.0).
 *
 * The installer prefers the official `codex mcp add` / `codex mcp remove` (which edit the file
 * with a formatting-preserving TOML writer); this is the fallback when only the Codex desktop app
 * or IDE extension is installed and there is no `codex` command. It only ever appends a table at
 * the end of the file and removes exactly that block again, so the round trip is byte-exact.
 * Anything it does not recognise as a plain `[mcp_servers.<name>]` table (an inline table, dotted
 * keys, a sub-table on its own) is reported as "other", and the installer prints manual steps
 * instead of guessing.
 */

export type CodexServer =
  | { kind: 'none' }
  | { kind: 'table'; start: number; end: number; values: Record<string, unknown> }
  | { kind: 'other'; line: number }

interface Line { start: number; end: number; text: string } // end includes the line break

function lines(text: string): Line[] {
  const out: Line[] = []
  let s = 0
  while (s < text.length) {
    const nl = text.indexOf('\n', s)
    const e = nl < 0 ? text.length : nl + 1
    out.push({ start: s, end: e, text: text.slice(s, e).replace(/\r?\n$/, '') })
    s = e
  }
  return out
}

/** `a."b.c".d` → ['a', 'b.c', 'd'] */
function keyPath(raw: string): string[] {
  const out: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while (re.lastIndex < raw.length && (m = re.exec(raw))) {
    out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] ?? m[3])
    if (!m[4]) break
  }
  return out
}

const HEADER = /^\s*\[(?!\[)([^\]]*)\]\s*(?:#.*)?$/
const ARRAY_HEADER = /^\s*\[\[([^\]]*)\]\]\s*(?:#.*)?$/
const KEYVAL = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=\s*(.*)$/

const startsWith = (a: string[], b: string[]) => b.every((s, k) => a[k] === s)
const same = (a: string[], b: string[]) => a.length === b.length && startsWith(a, b)

/** Parse the simple single-line values we compare: strings and arrays of strings. */
function simpleValue(raw: string): unknown {
  const v = raw.replace(/\s+#.*$/, '').trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) return JSON.parse(v)
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1)
  if (v.startsWith('[') && v.endsWith(']')) {
    const items = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
    const parsed = items.map((s) => simpleValue(s))
    return parsed.every((p) => typeof p === 'string') ? parsed : v
  }
  return v
}

export function findCodexServer(text: string, name: string): CodexServer {
  const target = ['mcp_servers', name]
  const ls = lines(text)
  let table: string[] = []
  let depth = 0 // open [ / { of a multi-line value
  let inMultiline: string | null = null
  let found: { startLine: number; endLine: number; values: Record<string, unknown> } | null = null
  let inOurs = false
  for (let k = 0; k < ls.length; k++) {
    const t = ls[k].text
    if (inMultiline) { if (t.split(inMultiline).length % 2 === 0) inMultiline = null; continue }
    if (depth > 0) { depth += bracketDelta(t); continue }
    const h = HEADER.exec(t) ?? ARRAY_HEADER.exec(t)
    if (h) {
      table = keyPath(h[1])
      const isArray = ARRAY_HEADER.test(t)
      if (inOurs && startsWith(table, target) && table.length > target.length) continue // [mcp_servers.<name>.env] etc.
      if (inOurs) { found!.endLine = k; inOurs = false }
      if (!isArray && same(table, target)) {
        if (found) return { kind: 'other', line: k + 1 } // defined twice
        found = { startLine: k, endLine: ls.length, values: {} }
        inOurs = true
      } else if (startsWith(table, target) || (isArray && startsWith(target, table))) {
        return { kind: 'other', line: k + 1 }
      }
      continue
    }
    const kv = KEYVAL.exec(t)
    if (!kv || /^\s*#/.test(t)) continue
    const full = [...table, ...keyPath(kv[1])]
    const rest = kv[2]
    for (const q of ['"""', "'''"]) if (rest.split(q).length % 2 === 0) inMultiline = q
    depth = bracketDelta(rest)
    if (inOurs && full.length === target.length + 1) found!.values[full[target.length]] = simpleValue(rest)
    else if (!inOurs && (startsWith(full, target) || startsWith(target, full))) return { kind: 'other', line: k + 1 }
  }
  if (!found) return { kind: 'none' }
  // The block ends before the next foreign header; blank and comment lines right before that
  // header belong to whatever follows, so they stay.
  let end = found.endLine
  while (end - 1 > found.startLine && /^\s*(#.*)?$/.test(ls[end - 1].text)) end--
  const endOffset = end < ls.length ? ls[end].start : text.length
  return { kind: 'table', start: ls[found.startLine].start, end: endOffset, values: found.values }
}

function bracketDelta(s: string): number {
  const bare = s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*$/, '')
  return (bare.match(/[[{]/g)?.length ?? 0) - (bare.match(/[\]}]/g)?.length ?? 0)
}

export interface CodexEntry { url?: string; command?: string; args?: string[] }

const tomlString = (s: string) => JSON.stringify(s) // a JSON string is a valid TOML basic string

/** Append the table at the end of the file, after one blank line. */
export function appendCodexServer(text: string, name: string, entry: CodexEntry): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let out = text
  if (out.length && !out.endsWith('\n')) out += eol
  if (/\S/.test(out)) out += eol
  out += `[mcp_servers.${name}]${eol}`
  if (entry.url) out += `url = ${tomlString(entry.url)}${eol}`
  if (entry.command) out += `command = ${tomlString(entry.command)}${eol}`
  if (entry.args) out += `args = [${entry.args.map(tomlString).join(', ')}]${eol}`
  return out
}

/** Remove a block found by findCodexServer, plus the blank line in front of it. */
export function removeCodexServer(text: string, found: Extract<CodexServer, { kind: 'table' }>): string {
  let start = found.start
  const before = text.slice(0, start)
  const blank = /(?:^|\n)[ \t]*\r?\n$/.exec(before)
  if (blank && start > 0) start = before.length - blank[0].length + (blank[0].startsWith('\n') ? 1 : 0)
  return text.slice(0, start) + text.slice(found.end)
}

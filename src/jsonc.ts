/**
 * Format- and comment-preserving edits to JSON / JSONC files — the MCP client configs that
 * `apimodels-mcp install` merges into (0.10.0).
 *
 * Why not JSON.parse + JSON.stringify: VS Code's mcp.json, Cursor's mcp.json, OpenCode's
 * opencode.jsonc and Gemini CLI's settings.json are routinely hand-edited and carry comments,
 * trailing commas and the owner's own indentation. A parse/stringify round trip silently
 * deletes all of that. Instead we parse into a tree that remembers byte offsets, then splice
 * only the bytes of the one property we add, replace or remove. Everything else in the file —
 * comments, blank lines, key order, tabs vs spaces, CRLF — stays byte-for-byte as it was, and
 * removing what we added gives back the original file exactly.
 *
 * The installer re-parses every result and compares it with the intended value before writing
 * (see install.ts), so a bug here can make the installer refuse a file, never corrupt one.
 */

export type JNode = JObject | JArray | JScalar
export interface JObject { kind: 'object'; start: number; end: number; members: JMember[] }
export interface JArray { kind: 'array'; start: number; end: number; items: JNode[] }
export interface JScalar { kind: 'scalar'; start: number; end: number; value: unknown }
/** `comma` is the offset of the "," right after the value, or -1 when there is none. */
export interface JMember { key: string; keyStart: number; value: JNode; comma: number }

export class JsoncError extends Error {}

const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** Parse JSON with comments and trailing commas (what VS Code calls JSONC). Throws JsoncError. */
export function parseJsonc(text: string): JNode {
  let i = 0
  const n = text.length
  const fail = (msg: string): never => {
    const line = text.slice(0, i).split('\n').length
    throw new JsoncError(`${msg} (line ${line})`)
  }
  const skip = () => {
    for (;;) {
      if (isWs(text[i])) { i++; continue }
      if (text[i] === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue }
      if (text[i] === '/' && text[i + 1] === '*') {
        const e = text.indexOf('*/', i + 2)
        if (e < 0) fail('unterminated /* comment')
        i = e + 2
        continue
      }
      return
    }
  }
  const str = (): string => {
    const s = i++
    while (i < n) {
      const c = text[i]
      if (c === '\\') { i += 2; continue }
      if (c === '"') {
        i++
        try { return JSON.parse(text.slice(s, i)) } catch { return fail('bad string escape') }
      }
      if (c === '\n' || c === '\r') fail('line break inside a string')
      i++
    }
    return fail('unterminated string')
  }
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  const value = (): JNode => {
    skip()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const members: JMember[] = []
      for (;;) {
        skip()
        if (text[i] === '}') { i++; break }
        if (text[i] !== '"') fail('expected a "property name" or }')
        const keyStart = i
        const key = str()
        skip()
        if (text[i] !== ':') fail('expected ":"')
        i++
        const m: JMember = { key, keyStart, value: value(), comma: -1 }
        members.push(m)
        skip()
        if (text[i] === ',') { m.comma = i++; continue }
        if (text[i] === '}') { i++; break }
        fail('expected "," or "}"')
      }
      return { kind: 'object', start, end: i, members }
    }
    if (c === '[') {
      i++
      const items: JNode[] = []
      for (;;) {
        skip()
        if (text[i] === ']') { i++; break }
        items.push(value())
        skip()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; break }
        fail('expected "," or "]"')
      }
      return { kind: 'array', start, end: i, items }
    }
    if (c === '"') return { kind: 'scalar', start, end: (str(), i), value: JSON.parse(text.slice(start, i)) }
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(lit, i)) { i += lit.length; return { kind: 'scalar', start, end: i, value: v } }
    }
    NUM.lastIndex = i
    const m = NUM.exec(text)
    if (m) { i += m[0].length; return { kind: 'scalar', start, end: i, value: Number(m[0]) } }
    return fail(i >= n ? 'unexpected end of file' : `unexpected "${c}"`)
  }
  const root = value()
  skip()
  if (i < n) fail('unexpected content after the closing bracket')
  return root
}

/** Plain JS value of a node (later duplicate keys win, as in JSON.parse). */
export function toValue(node: JNode): unknown {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'array') return node.items.map(toValue)
  const o: Record<string, unknown> = {}
  for (const m of node.members) Object.defineProperty(o, m.key, { value: toValue(m.value), enumerable: true, writable: true, configurable: true })
  return o
}

export interface Fmt { indent: string; eol: string }

/** Indent unit = leading whitespace of the first indented "key"; EOL = CRLF if the file uses it. */
export function detectFormat(text: string): Fmt {
  const m = /^([ \t]+)"/m.exec(text)
  return { indent: m ? m[1] : '  ', eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

interface Edit { start: number; end: number; text: string }

function applyEdits(text: string, edits: Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1
const lineIndent = (text: string, pos: number) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))![0]
const startsLine = (text: string, pos: number) => /^[ \t]*$/.test(text.slice(lineStart(text, pos), pos))
/** Offset just after the last non-whitespace character before pos (a value, comma or comment). */
function afterLastToken(text: string, pos: number): number {
  let j = pos
  while (j > 0 && isWs(text[j - 1])) j--
  return j
}

function valueText(value: unknown, memberIndent: string, fmt: Fmt): string {
  return JSON.stringify(value, null, fmt.indent).split('\n').join(fmt.eol + memberIndent)
}

function memberIndentOf(text: string, obj: JObject, fmt: Fmt): string {
  const first = obj.members[0]
  if (first && startsLine(text, first.keyStart)) return lineIndent(text, first.keyStart)
  return lineIndent(text, obj.start) + fmt.indent
}

function findOne(obj: JObject, key: string): { member: JMember; index: number } | null {
  const hits = obj.members.map((member, index) => ({ member, index })).filter((h) => h.member.key === key)
  if (hits.length > 1) throw new JsoncError(`"${key}" appears more than once`)
  return hits[0] ?? null
}

export type Lookup =
  | { found: false }
  | { found: true; value: unknown }

/** Read root[path...][key]. Throws JsoncError when something on the path is not an object. */
export function lookup(root: JNode, path: string[], key: string): Lookup {
  let obj = root
  for (const seg of [...path, key]) {
    if (obj.kind !== 'object') throw new JsoncError(`"${seg}" sits under something that is not an object`)
    const hit = findOne(obj, seg)
    if (!hit) return { found: false }
    obj = hit.member.value
  }
  return { found: true, value: toValue(obj) }
}

function insertEdits(text: string, obj: JObject, key: string, value: unknown, fmt: Fmt): Edit[] {
  const close = obj.end - 1
  const indent = memberIndentOf(text, obj, fmt)
  const member = `${JSON.stringify(key)}: ${valueText(value, indent, fmt)}`
  const at = afterLastToken(text, close)
  if (!obj.members.length) {
    if (!/\S/.test(text.slice(obj.start + 1, close))) {
      // {} or { } — lay the object out from scratch
      const closeIndent = startsLine(text, close) ? lineIndent(text, close) : lineIndent(text, obj.start)
      return [{ start: obj.start + 1, end: close, text: fmt.eol + indent + member + fmt.eol + closeIndent }]
    }
    return [{ start: at, end: at, text: fmt.eol + indent + member }] // only comments inside
  }
  const last = obj.members[obj.members.length - 1]
  // The file already ends its members with a trailing comma: keep that style.
  if (last.comma >= 0) return [{ start: at, end: at, text: fmt.eol + indent + member + ',' }]
  // Comma right after the last value, the new member after any comment that follows it.
  // (Same offset when there is no comment: applyEdits keeps array order for ties and the
  // later insert lands in front, so the member is listed first to end up after the comma.)
  return [
    { start: at, end: at, text: fmt.eol + indent + member },
    { start: last.value.end, end: last.value.end, text: ',' },
  ]
}

function removeEdits(text: string, obj: JObject, index: number): Edit[] {
  const m = obj.members[index]
  const from = afterLastToken(text, m.keyStart)
  const edits: Edit[] = []
  if (m.comma >= 0) edits.push({ start: from, end: m.comma + 1, text: '' })
  else {
    edits.push({ start: from, end: m.value.end, text: '' })
    if (index > 0) { const prev = obj.members[index - 1]; edits.push({ start: prev.comma, end: prev.comma + 1, text: '' }) }
  }
  // Removing the only member: collapse what is left to {} when nothing but whitespace remains.
  if (obj.members.length === 1) {
    const close = obj.end - 1
    const end = m.comma >= 0 ? m.comma + 1 : m.value.end
    if (!/\S/.test(text.slice(obj.start + 1, from)) && !/\S/.test(text.slice(end, close))) return [{ start: obj.start + 1, end: close, text: '' }]
  }
  return edits
}

/** Walk to root[path...]; returns the deepest existing object and the path segments still missing. */
function walk(root: JNode, path: string[]): { obj: JObject; missing: string[] } {
  if (root.kind !== 'object') throw new JsoncError('the file is not a JSON object')
  let obj = root
  for (let k = 0; k < path.length; k++) {
    const hit = findOne(obj, path[k])
    if (!hit) return { obj, missing: path.slice(k) }
    if (hit.member.value.kind !== 'object') throw new JsoncError(`"${path.slice(0, k + 1).join('.')}" is not an object`)
    obj = hit.member.value
  }
  return { obj, missing: [] }
}

/** Set root[path...][key] = value (adding any missing parent objects), touching nothing else. */
export function setMember(text: string, path: string[], key: string, value: unknown): string {
  const fmt = detectFormat(text)
  const { obj, missing } = walk(parseJsonc(text), path)
  if (missing.length) {
    // Build {missing[1]: {…: {key: value}}} and insert it under missing[0].
    let nested: unknown = { [key]: value }
    for (const seg of missing.slice(1).reverse()) nested = { [seg]: nested }
    return applyEdits(text, insertEdits(text, obj, missing[0], nested, fmt))
  }
  const hit = findOne(obj, key)
  if (!hit) return applyEdits(text, insertEdits(text, obj, key, value, fmt))
  const m = hit.member
  const indent = startsLine(text, m.keyStart) ? lineIndent(text, m.keyStart) : memberIndentOf(text, obj, fmt)
  return applyEdits(text, [{ start: m.value.start, end: m.value.end, text: valueText(value, indent, fmt) }])
}

/** Remove root[path...][key]; returns null when it is not there. */
export function removeMember(text: string, path: string[], key: string): string | null {
  const { obj, missing } = walk(parseJsonc(text), path)
  if (missing.length) return null
  const hit = findOne(obj, key)
  return hit ? applyEdits(text, removeEdits(text, obj, hit.index)) : null
}

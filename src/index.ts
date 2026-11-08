#!/usr/bin/env node
/**
 * apimodels-mcp — Model Context Protocol server for apimodels.app
 *
 * Exposes chat, image, video, speech, music / sound, embeddings, media extraction, the Jev decision model
 * and the asset library as MCP tools, so any MCP client (Claude Desktop, Cursor, …) can call every
 * apimodels model with a single API key (0.8.0: every endpoint in /v1/models except the realtime websocket).
 *
 * API key: `npx -y apimodels-mcp login` (browser authorization, 0.6.0) stores it in ~/.apimodels/credentials.json,
 * or set APIMODELS_API_KEY (used first). See credentials.ts for why the file exists.
 *
 * Config (environment variables):
 *   APIMODELS_API_KEY       (optional)  your sk_… key from https://apimodels.app/console/api-keys
 *   APIMODELS_CREDENTIALS_FILE (optional) where `login` stores the key, default ~/.apimodels/credentials.json
 *   APIMODELS_BASE_URL      (optional)  default https://api.apimodels.app/v1
 *   APIMODELS_WAIT_SECONDS  (optional)  default wait_seconds for generate_* / get_task, default 50
 *   APIMODELS_TIMEOUT_MS    (deprecated) the same wait in milliseconds; honoured for old configs
 *
 * Why generation is two-step (0.3.0):
 *   generate_image / generate_video / text_to_speech submit the job and wait at most
 *   wait_seconds for it. If it is still running they return the task id and the agent
 *   calls get_task. Up to 0.2.x they blocked for up to 5 minutes, which lost results in
 *   two ways: Codex kills a tool call after 60 s by default (tool_timeout_sec), and the
 *   5-minute cap was below what video actually takes (production p50 142 s, p90 486 s,
 *   week to 2026-09-22). Either way the task kept running, the account was billed on
 *   success, and the agent never saw the URL. The default of 50 s keeps a single call
 *   inside Codex's limit; Claude Code allows hours, so pass a larger wait_seconds there.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { makeUploadToken, UPLOAD_TTL_MS } from './upload-token.js'
import { resolveKey, runCli, CLI_COMMANDS, KEYS_URL } from './credentials.js'

const BASE_URL = (process.env.APIMODELS_BASE_URL || 'https://api.apimodels.app/v1').replace(/\/$/, '')
/** Longest a single tool call may wait. Claude Code's stdio idle limit is 30 min; stay well under it. */
const MAX_WAIT_S = 900
const DEFAULT_WAIT_S = Math.min(
  MAX_WAIT_S,
  Number(process.env.APIMODELS_WAIT_SECONDS)
    || Math.round((Number(process.env.APIMODELS_TIMEOUT_MS) || 0) / 1000)
    || 50,
)
const POLL_INTERVAL_MS = 3_000

// Do NOT exit when the key is missing: directory scanners and MCP inspectors start
// the server without credentials just to read the tool list. The key is checked
// when a tool actually needs the API (requireKey below) — and looked up again each
// time, so a `login` done while the agent is running takes effect immediately.
// The message is read by the agent: it must send the user to a terminal, never ask
// them to paste the key into the chat.
const NO_KEY_MSG = `No apimodels API key found. Run \`npx -y apimodels-mcp login\` (you can run it for the user): it opens apimodels.app in their browser, they click Authorize, and the key is saved on this machine — nothing to copy or paste, no restart needed. Do not ask the user to paste a key into the chat. Keys: ${KEYS_URL}`

const VERSION = '0.8.0'

/**
 * Hosted mode (`apimodels-mcp serve`, see http.ts): every HTTP request runs inside
 * requestKey.run({ key }) with the caller's own token, so the helpers below call the API
 * as that user. In hosted mode there is no fallback to a key on this machine, files and
 * private URLs are refused, and waits are capped (runtime.waitCap).
 */
export const requestKey = new AsyncLocalStorage<{ key: string }>()
export const runtime = { remote: false, waitCap: MAX_WAIT_S }
const REMOTE_WAIT_CAP_S = 50
const REMOTE_FILE_MSG = 'This is the hosted apimodels MCP server, so it cannot read files or private URLs on the user\'s machine. Call get_upload_url, upload the file with the curl command it returns, then pass the URL it prints.'

function requireKey(): string {
  const scoped = requestKey.getStore()?.key
  if (scoped) return scoped
  if (runtime.remote) throw new Error('Not signed in.')
  const k = resolveKey()
  if (!k) throw new Error(NO_KEY_MSG)
  return k.key
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  const key = requireKey()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let json: any
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) {
    // /v1/assets* answers { code: 'error', message }, the generation endpoints { msg }, the LLM gateway { error: { message } }.
    const msg = json?.msg || json?.message || json?.error?.message || json?.error || text || `HTTP ${res.status}`
    throw new Error(`apimodels API error (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return json
}

/**
 * POST that answers with raw bytes instead of JSON (ElevenLabs TTS on /v1/tts/stream streams audio/mpeg).
 * Errors still come back as JSON, so they are decoded the same way as apiFetch.
 */
async function apiFetchBytes(path: string, body: unknown): Promise<{ buf: Buffer; contentType: string }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim()
  if (!res.ok || contentType.includes('json')) {
    const raw = await res.text()
    let j: any
    try { j = JSON.parse(raw) } catch { j = {} }
    const msg = j?.msg || j?.message || j?.error?.message || j?.error || raw || `HTTP ${res.status}`
    throw new Error(`apimodels API error (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: contentType || 'audio/mpeg' }
}

/** Pretty JSON for tools whose answer is structured data the agent reads field by field. */
const json = (v: unknown) => JSON.stringify(v, null, 2)

/**
 * Turn whatever the caller gave us into a URL our servers can actually fetch.
 *
 * The problem this exists for: agents keep passing a local path, or a URL on the
 * user's own machine like `http://127.0.0.1:8000/photo.png`. Our generation
 * servers cannot reach either — `127.0.0.1` there means *our* box, not theirs —
 * so the job dies with an upstream "private/reserved IP addresses not allowed"
 * that tells the agent nothing about what to do instead.
 *
 * It cannot be fixed server-side: the file only exists on the user's machine.
 * But this MCP server *runs* on that machine, so it can read the path, or fetch
 * that localhost URL, and upload the bytes to `/v1/files` — which hands back a
 * public URL. From the caller's point of view a local file just works.
 *
 * Passes public http(s) URLs and asset:// references (from upload_asset) straight through untouched.
 * Works for images, video and audio alike: /v1/files takes images and audio up to 10 MB, video up to 100 MB.
 */
async function resolveMediaInput(input: string): Promise<string> {
  const raw = input.trim()

  // asset://… — a registered asset (upload_asset). Resolved server-side; never a file path.
  if (/^asset:\/\//i.test(raw)) return raw

  // data: URI — already bytes, just upload them.
  if (raw.startsWith('data:')) {
    const m = raw.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
    if (!m) throw new Error('Malformed data: URI')
    const [, mime, isB64, payload] = m
    const buf = Buffer.from(isB64 ? payload : decodeURIComponent(payload), isB64 ? 'base64' : 'utf8')
    return uploadBytes(buf, `input.${(mime.split('/')[1] || 'png').replace(/[^\w]/g, '')}`, mime)
  }

  if (/^https?:\/\//i.test(raw)) {
    const host = new URL(raw).hostname
    const isLocal =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local')
    if (!isLocal) return raw // public URL — our servers can fetch it themselves
    if (runtime.remote) throw new Error(REMOTE_FILE_MSG)

    // Reachable from here (this process is on the user's machine), not from ours.
    const res = await fetch(raw)
    if (!res.ok) throw new Error(`Could not read ${raw} from this machine (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'input.png')
    return uploadBytes(buf, name, res.headers.get('content-type') || guessMime(name))
  }

  // Anything else is treated as a filesystem path (absolute, relative, or ~).
  if (runtime.remote) throw new Error(REMOTE_FILE_MSG)
  const path = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    throw new Error(
      `Not a URL, and no readable file at "${raw}". Pass a public https:// URL, a local file path, or a data: URI.`,
    )
  }
  return uploadBytes(buf, basename(path), guessMime(path))
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  heic: 'image/heic', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split(/[?#]/)[0].split('.').pop() || ''
  return MIME_BY_EXT[ext] || 'image/png'
}

/** Image / Video / Audio, for /v1/assets asset_type. Undefined when the extension says nothing. */
function assetTypeOf(name: string): 'Image' | 'Video' | 'Audio' | undefined {
  const ext = name.toLowerCase().split(/[?#]/)[0].split('.').pop() || ''
  const mime = MIME_BY_EXT[ext]
  if (!mime) return undefined
  return mime.startsWith('video/') ? 'Video' : mime.startsWith('audio/') ? 'Audio' : 'Image'
}

/** Public video model ids whose request reads the first frame from the scalar `image` field rather than images[]. */
const FIRST_FRAME_AS_IMAGE = new Set(['kling-v2-6', 'kling-video-o1', 'kling-v3-omni', 'kling-effects', 'dreamactor-v2', 'v3.1-fast-start-end', 'wan-animate'])

/** Resolve every entry of an optional list (local paths / data: URIs uploaded, URLs and asset:// passed through). */
async function resolveMediaList(list?: string[]): Promise<string[] | undefined> {
  if (!list?.length) return undefined
  return Promise.all(list.map(resolveMediaInput))
}

/** The caller's free-form extra parameters, minus the keys a tool sets itself (those always win). */
function extraParams(extra: Record<string, unknown> | undefined, reserved: string[]): Record<string, unknown> {
  if (!extra) return {}
  return Object.fromEntries(Object.entries(extra).filter(([k]) => !reserved.includes(k)))
}

/** Upload bytes to /v1/files and return the public URL it mints. */
async function uploadBytes(buf: Buffer, filename: string, contentType: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)], { type: contentType }), filename)
  // No Content-Type header here on purpose — fetch must set the multipart boundary.
  const res = await fetch(`${BASE_URL}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireKey()}` },
    body: form,
  })
  const json: any = await res.json().catch(() => ({}))
  const url = json?.data?.publicUrl
  if (!res.ok || !url) {
    throw new Error(`Upload of ${filename} failed: ${json?.msg || `HTTP ${res.status}`}`)
  }
  return url
}

type Kind = 'images' | 'video' | 'audio'
const KIND_LABEL: Record<Kind, string> = { images: 'image', video: 'video', audio: 'audio' }

/**
 * Production generation times (seconds) for the 7 days to 2026-09-22, successful tasks
 * only. Quoted back to the agent when a task is still running so its next wait is sized
 * from data rather than guessed. Refresh when the fleet changes materially.
 */
const TYPICAL_S: Record<Kind, { p50: number; p90: number }> = {
  images: { p50: 48, p90: 83 },
  video: { p50: 142, p90: 486 },
  audio: { p50: 3, p90: 9 },
}

/**
 * Submit a generation and wait up to waitS for it. Billing happens on completion, not here.
 *
 * Image requests carry `async: true`: with an exact WxH `size` the images endpoint otherwise switches to
 * OpenAI's synchronous mode — one request that blocks until the image exists and answers {created, data:[…]}
 * with no task id (found 2026-11-08: a gpt-image-2.6 GIF with size 512x512 came back that way, was billed,
 * and this tool reported "No taskId returned"). An API that predates the flag still answers synchronously;
 * that answer is a finished result, so it is returned as completed instead of failing. response_format "url"
 * keeps that answer small (no base64 of the image).
 */
async function submitAndWait(kind: Kind, body: Record<string, unknown>, waitS: number): Promise<{ taskId: string; state: TaskState }> {
  const payload = kind === 'images' ? { ...body, async: true, response_format: 'url' } : body
  const created = await apiFetch(`/${kind}/generations`, { method: 'POST', body: JSON.stringify(payload) })
  const taskId: string | undefined = created?.data?.taskId
  if (taskId) return { taskId, state: await pollTask(kind, taskId, waitS) }
  if (created?.error) {
    const e = created.error
    return { taskId: '(synchronous)', state: { state: 'failed', message: typeof e === 'string' ? e : e.message || JSON.stringify(e), retryable: false, kind } }
  }
  const urls: string[] = Array.isArray(created?.data) ? created.data.map((d: any) => d?.url).filter((u: unknown) => typeof u === 'string') : []
  if (urls.length) return { taskId: '(synchronous)', state: { state: 'completed', urls, kind } }
  throw new Error(`No taskId returned: ${JSON.stringify(created).slice(0, 500)}`)
}

/** One entry of resultJson.layers — returned by Seedream 5.0 Flash layer splitting. Index 0 is the flattened base. */
type LayerInfo = { name?: string; role?: string; z_index?: number; description?: string; bounding_box?: { absolute?: number[]; normalized?: number[] } }

type TaskState =
  | { state: 'completed'; urls: string[]; kind: Kind; layers?: LayerInfo[] }
  | { state: 'failed'; message: string; retryable: boolean; kind: Kind }
  | { state: 'running'; elapsedS: number; kind: Kind }

/**
 * The API's modelType (TEXT_TO_IMAGE, IMAGE_TO_VIDEO, TEXT_TO_SPEECH, …) says what a
 * task is regardless of which endpoint was asked — task lookup is by id alone on the
 * server, so get_task does not need the caller to remember the kind. VIDEO is tested
 * first because IMAGE_TO_VIDEO contains both words.
 */
function kindOf(modelType: unknown, fallback: Kind): Kind {
  const t = typeof modelType === 'string' ? modelType : ''
  if (t.includes('VIDEO')) return 'video'
  if (t.includes('IMAGE')) return 'images'
  if (t.includes('SPEECH') || t.includes('AUDIO')) return 'audio'
  return fallback
}

/**
 * Poll a task for up to waitS seconds. Returns 'running' instead of throwing when time
 * runs out: that is a normal outcome the agent must act on (call get_task), not an error.
 * waitS = 0 checks once and returns.
 */
async function pollTask(kind: Kind, taskId: string, waitS: number): Promise<TaskState> {
  const deadline = Date.now() + Math.min(waitS, runtime.waitCap) * 1000
  for (;;) {
    const polled = await apiFetch(`/${kind}/generations?task_id=${encodeURIComponent(taskId)}`)
    const d = polled?.data ?? {}
    const k = kindOf(d.modelType, kind)
    if (d.state === 'completed') {
      const urls: string[] = d.resultUrls || []
      if (!urls.length) throw new Error(`Task ${taskId} completed but returned no result URLs`)
      // Layer splitting returns one URL per layer and the per-layer metadata in
      // resultJson.layers; the task endpoint serialises resultJson as a string.
      let layers: LayerInfo[] | undefined
      try {
        const rj = typeof d.resultJson === 'string' ? JSON.parse(d.resultJson) : d.resultJson
        if (Array.isArray(rj?.layers)) layers = rj.layers
      } catch { /* no layer metadata */ }
      return { state: 'completed', urls, kind: k, ...(layers ? { layers } : {}) }
    }
    if (d.state === 'failed') {
      return { state: 'failed', message: d.failMsg || d.failCode || 'unknown error', retryable: Boolean(d.retryable), kind: k }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const created = typeof d.createTime === 'number' ? d.createTime : Date.now()
      return { state: 'running', elapsedS: Math.max(0, Math.round((Date.now() - created) / 1000)), kind: k }
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining))
  }
}

/** What the agent gets when a task has not finished inside the wait: enough to continue, nothing to guess. */
function runningText(taskId: string, s: Extract<TaskState, { state: 'running' }>): string {
  const t = TYPICAL_S[s.kind]
  return [
    `STILL RUNNING — ${KIND_LABEL[s.kind]} task ${taskId}, ${s.elapsedS}s elapsed.`,
    `Typical ${KIND_LABEL[s.kind]} generation: median ${t.p50}s, 9 in 10 finish within ${t.p90}s.`,
    `Next: call get_task with task_id "${taskId}" (it waits up to wait_seconds, default ${DEFAULT_WAIT_S}). Do NOT submit the job again — this task keeps running, is billed once when it completes, and its result stays retrievable for 30 days.`,
  ].join('\n')
}

function failedText(taskId: string, s: Extract<TaskState, { state: 'failed' }>): string {
  return `FAILED — ${KIND_LABEL[s.kind]} task ${taskId}: ${s.message}${s.retryable ? ' (transient; retrying the same request is reasonable)' : ''}. Failed tasks are not billed.`
}

/**
 * A downscaled JPEG of a generated image, so a client that forwards tool-result
 * images to the model (Claude Desktop, Claude Code, Cursor) lets the model SEE
 * what it made and iterate on it. Full-size results run 1–8 MB; resent on every
 * turn that would swamp the context, so we cap the long edge at 1024px.
 *
 * sharp is an optionalDependency: if it failed to install on this platform we
 * fall back to the original bytes when they are small enough, else no preview.
 * Never throws — a missing preview must not fail a generation that succeeded
 * (and was billed).
 */
const PREVIEW_MAX_EDGE = 1024
const PREVIEW_RAW_LIMIT = 1_000_000

async function imagePreview(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    try {
      const mod = 'sharp' // indirect so tsc does not require the optional package
      const sharp = (await import(mod)).default
      const out: Buffer = await sharp(buf)
        .rotate()
        .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      return { data: out.toString('base64'), mimeType: 'image/jpeg' }
    } catch {
      const mime = (res.headers.get('content-type') || guessMime(url)).split(';')[0].trim()
      if (buf.length <= PREVIEW_RAW_LIMIT && /^image\/(png|jpeg|webp|gif)$/.test(mime)) {
        return { data: buf.toString('base64'), mimeType: mime }
      }
      return null
    }
  } catch {
    return null
  }
}

const REVIEW_SYSTEM = [
  'You are reviewing an AI-generated image against the brief it was generated from.',
  'Look at the image carefully and answer in three short parts:',
  '1. MATCHES — what the image gets right.',
  '2. PROBLEMS — what is wrong or missing. Be concrete: misspelled or garbled text (quote it), wrong counts, composition, colors, anatomy, artifacts, aspect ratio.',
  '3. REVISED PROMPT — one complete prompt that would fix the problems. If the image already satisfies the brief, say "No changes needed" instead.',
].join('\n')

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true })

/** Layer-split result: one line per image with the layer name and its box in the original (pixels), then the URL. */
function layerText(urls: string[], layers: LayerInfo[]): string {
  const lines = urls.map((u, i) => {
    const l = layers[i] ?? {}
    const box = l.bounding_box?.absolute ? ` box=[${l.bounding_box.absolute.join(',')}]` : ''
    return `[${i}] ${l.name ?? (i === 0 ? 'base' : 'layer')}${box}\n    ${u}`
  })
  return [
    `LAYERS — ${urls.length} images: [0] is the flattened base, [1..] are transparent PNG layers in stacking order (box = x1,y1,x2,y2 in the original image). Billed per image. Layer names come from the model and may be in Chinese.`,
    ...lines,
  ].join('\n')
}

/** Result URLs, plus previews for image tasks when asked. Shared by generate_image and get_task. */
async function taskResult(taskId: string, s: TaskState, returnImage: boolean) {
  if (s.state === 'running') return text(runningText(taskId, s))
  if (s.state === 'failed') return { ...text(failedText(taskId, s)), isError: true }
  const previews = returnImage && s.kind === 'images' ? await Promise.all(s.urls.slice(0, 2).map(imagePreview)) : []
  return {
    content: [
      { type: 'text' as const, text: s.layers ? layerText(s.urls, s.layers) : s.urls.join('\n') },
      ...previews.flatMap((p) => (p ? [{ type: 'image' as const, data: p.data, mimeType: p.mimeType }] : [])),
    ],
  }
}

const waitSecondsParam = (what: string) =>
  z.number().int().min(0).max(MAX_WAIT_S).default(Math.min(DEFAULT_WAIT_S, runtime.waitCap)).describe(
    runtime.remote
      ? `How long to wait for the ${what} before returning a task id instead (seconds). This hosted server waits at most ${runtime.waitCap} s per call; call get_task with the id to keep waiting.`
      : `How long to wait for the ${what} before returning a task id instead (seconds, 0–${MAX_WAIT_S}). Default ${DEFAULT_WAIT_S}: Codex aborts tool calls at 60 s unless tool_timeout_sec is raised. In Claude Code / Claude Desktop you can pass up to ${MAX_WAIT_S} to get the URL in one call.`,
  )

/**
 * Tool annotations (MCP spec). Clients use them to decide whether a call needs the user's OK:
 * Codex (0.162, verified 2026-10-10) asks for approval on every call to a tool that is not marked
 * read-only — including every get_task poll while a video renders, so one video meant several
 * approval prompts. list_models and get_task only read, so they are read-only and run without a
 * prompt. Everything else submits billable work and stays approval-gated on purpose.
 */
const READ_ONLY = { readOnlyHint: true } as const
const BILLABLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'apimodels-mcp', version: VERSION })

  server.tool(
    'get_balance',
    'Show the apimodels account balance (USD) for the configured API key. Check it before submitting a batch of generations, and tell the user if the balance looks too low for what they asked for.',
    {},
    { title: 'Get balance', ...READ_ONLY },
    async () => {
      try {
        const j = await apiFetch('/balance')
        const d = j?.data ?? j
        const n = (v: unknown) => Number(v ?? 0).toFixed(4)
        return text(`Balance: ${n(d?.balance)} ${d?.currency ?? 'USD'} available (total ${n(d?.total)}, held for running tasks ${n(d?.frozen)}). Top up: https://apimodels.app/console/credits`)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'list_models',
    'List the model ids available on apimodels.app, grouped by type with the endpoint each one uses. Every id listed is callable. Tool per endpoint: /v1/chat/completions → chat; /v1/images/generations → generate_image; /v1/video/generations → generate_video; /v1/audio/generations → text_to_speech (minimax-speech-*, fish-*, kling-tts) or generate_audio (music, sound effects, dialogue, dubbing, isolation); /v1/tts/stream (eleven-tts-*) → text_to_speech; /v1/embeddings → embed; /v1/media/extract → extract_media; /v1/systemone (jev) → jev_decide. The realtime voice model (wss) is not usable through MCP.',
    {},
    { title: 'List models', ...READ_ONLY },
    async () => {
      try {
        const res = await apiFetch('/models')
        const rows: Array<{ id: string; modality?: string; endpoint?: string }> = (res?.data || []).filter((m: any) => m?.id)
        if (!rows.length) return text(JSON.stringify(res))
        // The catalog carries modality + endpoint (2026-10). Group by modality so the caller can pick the right tool.
        const groups = new Map<string, string[]>()
        for (const m of rows) {
          const key = m.modality ? `${m.modality}${m.endpoint ? ` (${m.endpoint})` : ''}` : 'other'
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(m.id)
        }
        const order = ['chat', 'image', 'video', 'audio', 'embedding']
        const keys = [...groups.keys()].sort((a, b) => {
          const ia = order.findIndex(o => a.startsWith(o)), ib = order.findIndex(o => b.startsWith(o))
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
        })
        return text(keys.map(k => `## ${k}: ${groups.get(k)!.length}\n${groups.get(k)!.join('\n')}`).join('\n\n'))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'chat',
    'Chat / text completion with any LLM on apimodels.app (GPT-6.1, Claude, Gemini, GLM, DeepSeek, Qwen, …). Returns the assistant reply text.',
    {
      prompt: z.string().describe('The user message / prompt.'),
      model: z.string().default('gpt-6.1-sol').describe('Model id, e.g. gpt-6.1-sol, gpt-6-sol, claude-opus-5-5, claude-sonnet-5-5 (Claude Sonnet 5.5, fast and strong at coding and agent work, $1.20 / $6 per 1M tokens), claude-sonnet-5, gemini-3-pro-preview, deepseek-v4-pro. Call list_models for the full list.'),
      system: z.string().optional().describe('Optional system prompt.'),
      max_tokens: z.number().int().positive().optional().describe('Optional max output tokens.'),
    },
    { title: 'Chat', ...BILLABLE },
    async ({ prompt, model, system, max_tokens }) => {
      try {
        const messages = [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ]
        const res = await apiFetch('/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model, messages, ...(max_tokens ? { max_tokens } : {}) }),
        })
        const reply = res?.choices?.[0]?.message?.content
        return text(typeof reply === 'string' ? reply : JSON.stringify(res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'generate_image',
    'Generate an image from a text prompt, or edit / combine input images. Returns the URL(s) of the generated image(s), valid 30 days, plus a downscaled preview when the client can show tool-result images to you. Images take about 50 s (9 in 10 within 90 s); if the task is still running when wait_seconds is up you get a task id — call get_task with it, do not resubmit. If you cannot see the image in the result, call review_image with the returned URL to get a written critique and a revised prompt, then generate again. Roughly $0.025 per image on the default model; gpt-image-2-lite is $0.01. gpt-image-2.6-flare / gpt-image-2.6-sunburst can also return an animated GIF (output_format "gif", 2–16 frames) or an SVG vector (output_format "svg", text-to-image only, $0.0315); a GIF on a solid green screen comes back with the green keyed out to transparent (pass background "opaque" to keep it).',
    {
      prompt: z.string().optional().describe('Text description of the image to generate (or the edit to make). Required, except with layer_decomposition where it is optional.'),
      model: z.string().default('gpt-image-2').describe('Image model id, e.g. gpt-image-2, gpt-image-2.6-flare (GIF / SVG output, markup-image edits, up to 16 references), gpt-image-2.6-sunburst (highest fidelity), gpt-image-2.5-flare, flux-2-klein-4b ($0.006, fastest, up to 3 reference images), gpt-image-2-lite, gemini-3-pro-image, gemini-3-pro-image-gemini ($0.03 flat), qwen3-image (small in-image text), gemini-3.1-flash-image, nano-banana-2-1 (Google Nano Banana 2.1: $0.022 1K / $0.036 2K / $0.06 4K, accurate in-image text, 15 aspect ratios incl. 21:9 and 1:8), doubao-seedream-5-0-flash ($0.03, fast, 1K/2K; supports background and layer_decomposition), doubao-seedream-5-0-pro ($0.03 1K / $0.06 2K, precise region edits). Call list_models for the full list.'),
      aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 1:1, 16:9, 9:16.'),
      resolution: z.string().optional().describe('Optional resolution tier, e.g. 1K, 2K, 4K.'),
      size: z.string().optional().describe('Optional exact pixel size "WIDTHxHEIGHT", e.g. 1024x1024 or 1536x1024 (models that take exact sizes, such as the gpt-image family). For a GIF this is the size of each frame.'),
      image_url: z.string().optional().describe('Optional input image for edits. Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, a data: URI or an asset:// reference — local sources are uploaded for you automatically.'),
      image_urls: z.array(z.string()).max(16).optional().describe('Several input / reference images (up to 16 on gpt-image-2.6, fewer on most models — e.g. 3 on flux-2-klein-4b). Same accepted forms as image_url. Use this to combine subjects or keep a character consistent across images.'),
      mask_url: z.string().optional().describe('Optional edit mask: white = change, black = keep, same size as the first input image (gpt-image family). Not with gif output, and not together with markup_image_url.'),
      markup_image_url: z.string().optional().describe('Optional markup image for gpt-image-2.6 edits: a transparent PNG with only circles, arrows or notes drawn on it, the same size as the first input image; the model edits the first input accordingly.'),
      output_format: z.enum(['png', 'jpeg', 'webp', 'gif', 'svg']).optional().describe('Optional output format. gif = animated GIF and svg = vector, both on gpt-image-2.6 only. If omitted, opaque images are delivered as JPEG.'),
      frame_count: z.number().int().min(2).max(16).optional().describe('GIF only: number of frames, 2–16 (default 9).'),
      frame_duration_ms: z.number().int().min(20).max(2000).optional().describe('GIF only: milliseconds per frame, 20–2000 (default 200).'),
      n: z.number().int().min(1).max(10).optional().describe('Optional number of images to generate in one call (models that support it; billed per image).'),
      quality: z.string().optional().describe('Optional quality tier, e.g. low / medium / high (gpt-image family, Grok Imagine). Higher costs more.'),
      reasoning_effort: z.enum(['low', 'medium', 'high']).optional().describe('gpt-image-2.6 only: how much the model plans before drawing.'),
      background: z.enum(['transparent', 'opaque', 'auto']).optional().describe('"transparent": a transparent background (gpt-image family), or with doubao-seedream-5-0-flash / -pro keep the transparency of ONE input PNG passed as image_url. "opaque": force an opaque background — on gpt-image-2.6 GIFs this also stops the automatic green-screen keying.'),
      layer_decomposition: z.boolean().optional().describe('Split the image in image_url into a flattened base plus up to 16 transparent PNG layers (text blocks, subjects, props), each returned with a name and its box in the original. prompt is optional. Billed $0.03 per output image, so tell the user the cost depends on how many layers come back (at most $0.51). doubao-seedream-5-0-flash only.'),
      extra: z.record(z.unknown()).optional().describe('Optional model-specific parameters passed through as-is, e.g. {"seed": 42} or {"scale": 4, "face_enhance": true} for real-esrgan. See the model page on apimodels.app/docs. Keys set by the fields above are ignored here.'),
      return_image: z.boolean().default(true).describe('Attach a downscaled preview (max 1024px JPEG) of the result so you can look at it. Set false to save context when you only need the URL.'),
      wait_seconds: waitSecondsParam('image'),
    },
    { title: 'Generate image', ...BILLABLE },
    async ({ prompt, model, aspect_ratio, resolution, size, image_url, image_urls, mask_url, markup_image_url, output_format, frame_count, frame_duration_ms, n, quality, reasoning_effort, background, layer_decomposition, extra, return_image, wait_seconds }) => {
      try {
        if (!prompt && !layer_decomposition) throw new Error('prompt is required (it is optional only with layer_decomposition).')
        if (layer_decomposition && !image_url) throw new Error('layer_decomposition needs image_url: exactly one input image.')
        // Seedream keeps the alpha of an input PNG; the gpt-image family generates a transparent background from the prompt alone.
        if (background === 'transparent' && /^doubao-seedream/i.test(model) && !image_url) {
          throw new Error('With doubao-seedream models, background "transparent" needs image_url: exactly one input PNG with an alpha channel.')
        }
        if ((frame_count != null || frame_duration_ms != null) && output_format !== 'gif') throw new Error('frame_count and frame_duration_ms only apply with output_format "gif".')
        const body: Record<string, unknown> = {
          ...extraParams(extra, ['model', 'prompt']),
          model,
          ...(prompt ? { prompt } : {}),
          ...(background ? { background } : {}),
          ...(layer_decomposition ? { layer_decomposition: true } : {}),
          ...(aspect_ratio ? { aspect_ratio } : {}),
          ...(resolution ? { resolution } : {}),
          ...(size ? { size } : {}),
          ...(output_format ? { output_format } : {}),
          ...(frame_count != null ? { frame_count } : {}),
          ...(frame_duration_ms != null ? { frame_duration_ms } : {}),
          ...(n != null ? { n } : {}),
          ...(quality ? { quality } : {}),
          ...(reasoning_effort ? { reasoning_effort } : {}),
        }
        if (image_url) body.image_url = await resolveMediaInput(image_url)
        const refs = await resolveMediaList(image_urls)
        if (refs) body.image_urls = refs
        if (mask_url) body.mask_url = await resolveMediaInput(mask_url)
        if (markup_image_url) body.markup_image_url = await resolveMediaInput(markup_image_url)
        const { taskId, state } = await submitAndWait('images', body, wait_seconds)
        return await taskResult(taskId, state, return_image)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'review_image',
    'Have a vision model look at an image and critique it against a brief. Returns what matches, what is wrong (garbled text, composition, colors, artifacts) and a revised prompt. Use it after generate_image to check the result and decide whether to regenerate — this works in every MCP client, including ones that do not pass tool-result images to you. Costs one small vision chat call (well under $0.01 on the default model).',
    {
      image_url: z.string().describe('The image to review: a URL returned by generate_image, any public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI.'),
      brief: z.string().describe('What the image is supposed to show — usually the prompt it was generated from, plus any requirements the user stated (exact text, aspect ratio, style).'),
      model: z.string().default('gpt-5.6-luna').describe('Vision-capable chat model that does the looking. gpt-5.6-luna (default, lowest price) or claude-sonnet-5 for a more careful read.'),
    },
    { title: 'Review image', ...BILLABLE },
    async ({ image_url, brief, model }) => {
      try {
        const url = await resolveMediaInput(image_url)
        const res = await apiFetch('/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model,
            max_tokens: 900,
            messages: [
              { role: 'system', content: REVIEW_SYSTEM },
              { role: 'user', content: [
                { type: 'text', text: `BRIEF:\n${brief}` },
                { type: 'image_url', image_url: { url } },
              ] },
            ],
          }),
        })
        const reply = res?.choices?.[0]?.message?.content
        return text(typeof reply === 'string' && reply.trim() ? reply : JSON.stringify(res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'generate_video',
    'Generate or process a video: text-to-video, image-to-video, first + last frame, multi-reference, lip sync and talking avatars (image or video + audio), motion transfer (image + driving video), upscaling and subtitle removal (video in). Submits the job and waits up to wait_seconds: returns the video URL(s) (valid 30 days) if it finishes in time, otherwise a task id — then call get_task with that id; never resubmit a running task. Video takes a median 2.5 minutes and 9 in 10 finish within 8 minutes, so expect one or two get_task calls. Video is the most expensive modality here — the default model is billed per second ($0.071/s at 480p, $0.153/s at 720p, so a 5-second 480p clip is about $0.36); pass model:"veo-3.1-fast-fhd" for a flat $0.088 per 8-second 1080p clip. Each model reads only the inputs it supports — check its page on apimodels.app/docs.',
    {
      prompt: z.string().optional().describe('Text description of the video. Required by generation models; optional for processing models (video-upscale, flashvsr, subtitle-erase, lip sync with audio).'),
      model: z.string().default('seedance-2.0-fast').describe('Video model id. Generation: seedance-2.0-fast, seedance-2.0, seedance-2.0-mini, seedance-2.5, wan-3.0-video, minimax-h3, minimax-h3-lite (from $0.01/s, up to 768p), ltx-2.3, grok-imagine-video-1.5, veo-3.1-fast-fhd ($0.088 flat), veo-3.1, kling-v2-6, kling-4.0, vidu-q4. First + last frame (image_url + last_frame_url): v3.1-fast-start-end, seedance, kling. Talking avatar from a photo (image_url + audio_url): omnihuman-2.0, ai-lipsync. Talking avatar from a video (video_url + audio_url): digital-human. Motion transfer (image_url + driving video_url): dreamactor-v2, wan-animate, kling-motion-control, kling-v3-motion-control. Video in: video-upscale and flashvsr (upscale; target in resolution), subtitle-erase. Kling lip sync is two calls: kling-identify-face (video_url) returns a session and face ids, then kling-lip-sync-video (audio_url) or kling-lip-sync-tts (text / voiceId) with sessionId and faceId in extra. Call list_models for the full list.'),
      aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 16:9, 9:16, 1:1.'),
      resolution: z.string().optional().describe('Optional resolution, e.g. 480p, 720p, 1080p.'),
      duration: z.union([z.number(), z.string()]).optional().describe('Optional duration in seconds, e.g. 5 or 10.'),
      image_url: z.string().optional().describe('Optional first frame / subject image (image-to-video, avatar, motion transfer). Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, a data: URI or an asset:// reference — local sources are uploaded for you automatically.'),
      last_frame_url: z.string().optional().describe('Optional last frame for first + last frame models (e.g. v3.1-fast-start-end, seedance). Same accepted forms as image_url.'),
      image_urls: z.array(z.string()).optional().describe('Several input images for models that take more than one (e.g. omnihuman-2.0, multi-image references). Same accepted forms as image_url.'),
      reference_image_urls: z.array(z.string()).optional().describe('Seedance 2.x / Kling Omni reference images (characters, products, style), up to 9 on Seedance. asset:// references from upload_asset are accepted for a fixed real person.'),
      reference_video_urls: z.array(z.string()).optional().describe('Seedance 2.x reference videos (camera move, motion, edit target).'),
      reference_audio_urls: z.array(z.string()).optional().describe('Seedance 2.x reference audio (voice, music, sound).'),
      video_url: z.string().optional().describe('Input video for lip sync, motion transfer (driving video), upscaling, subtitle removal or video edits. Same accepted forms as image_url; local videos up to 100 MB are uploaded for you.'),
      audio_url: z.string().optional().describe('Input audio for talking avatars and lip sync (omnihuman-2.0, digital-human, ai-lipsync, kling-lip-sync-video). Same accepted forms as image_url; local audio up to 10 MB.'),
      negative_prompt: z.string().optional().describe('Optional: what to avoid (models that support it).'),
      seed: z.number().int().optional().describe('Optional random seed for repeatable results (models that support it).'),
      generate_audio: z.boolean().optional().describe('Optional: ask models that can add sound (e.g. Seedance, Veo) to generate audio — or set false for a silent clip.'),
      extra: z.record(z.unknown()).optional().describe('Optional model-specific parameters passed through as-is, e.g. {"mode": "pro"}, {"text": "…", "voice_id": "…"} for kling-lip-sync-tts, erase settings for subtitle-erase, {"keyframes": [...]}. See the model page on apimodels.app/docs. Keys set by the fields above are ignored here.'),
      wait_seconds: waitSecondsParam('video'),
    },
    { title: 'Generate video', ...BILLABLE },
    async ({ prompt, model, aspect_ratio, resolution, duration, image_url, last_frame_url, image_urls, reference_image_urls, reference_video_urls, reference_audio_urls, video_url, audio_url, negative_prompt, seed, generate_audio, extra, wait_seconds }) => {
      try {
        const body: Record<string, unknown> = {
          ...extraParams(extra, ['model', 'prompt']),
          model,
          ...(prompt ? { prompt } : {}),
          ...(aspect_ratio ? { aspect_ratio } : {}),
          ...(resolution ? { resolution } : {}),
          ...(duration != null ? { duration } : {}),
          ...(negative_prompt ? { negative_prompt } : {}),
          ...(seed != null ? { seed } : {}),
          ...(generate_audio != null ? { generate_audio } : {}),
        }
        // The video endpoint reads the first frame from different fields per model family (verified against the
        // backend's video-generations.ts, 2026-11-08): most read images[0] (what this tool has sent since 0.3); the
        // Kling video family, dreamactor-v2, v3.1-fast-start-end and wan-animate read the scalar `image` (images[] was
        // silently ignored there); Kling Motion Control requires input_urls + video_urls.
        const motionControl = /motion-control$/i.test(model)
        if (image_url) {
          const u = await resolveMediaInput(image_url)
          if (motionControl) body.input_urls = [u]
          else if (FIRST_FRAME_AS_IMAGE.has(model.toLowerCase())) body.image = u
          else body.images = [u]
        }
        // Last frame: Seedance / MiniMax / Vidu / Muse read last_frame_url, Kling and v3.1-fast-start-end read image_tail.
        if (last_frame_url) {
          const u = await resolveMediaInput(last_frame_url)
          body.last_frame_url = u
          body.image_tail = u
        }
        const lists: Array<[string, string[] | undefined]> = [
          ['image_urls', image_urls], ['reference_image_urls', reference_image_urls],
          ['reference_video_urls', reference_video_urls], ['reference_audio_urls', reference_audio_urls],
        ]
        for (const [key, list] of lists) {
          const resolved = await resolveMediaList(list)
          if (resolved) body[key] = resolved
        }
        if (video_url) {
          const u = await resolveMediaInput(video_url)
          if (motionControl) body.video_urls = [u]
          else body.video_url = u
        }
        if (audio_url) {
          const u = await resolveMediaInput(audio_url)
          body.audio_url = u
          if (model.toLowerCase() === 'kling-lip-sync-video') body.audioUrl = u // that route reads camelCase only
        }
        const { taskId, state } = await submitAndWait('video', body, wait_seconds)
        return await taskResult(taskId, state, false)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'get_task',
    'Check on, or wait for, an image / video / audio task that generate_image, generate_video, text_to_speech or generate_audio handed back as "still running". Returns the result URL(s) once it has finished (with an image preview for image tasks), a failure message if it failed, or "still running" again — in which case call get_task once more. Waits up to wait_seconds before answering, so one call usually suffices for a task that is nearly done. Task ids also appear at https://apimodels.app/console/records.',
    {
      task_id: z.string().describe('The task id from the "STILL RUNNING" message (or from the apimodels console).'),
      wait_seconds: waitSecondsParam('task'),
      return_image: z.boolean().default(true).describe('For image tasks, attach a downscaled preview of the result. Set false to save context.'),
    },
    { title: 'Get task result', ...READ_ONLY },
    async ({ task_id, wait_seconds, return_image }) => {
      try {
        // Lookup is by id alone server-side; the endpoint only names a default kind for the timing hints.
        return await taskResult(task_id, await pollTask('video', task_id.trim(), wait_seconds), return_image)
      } catch (e) { return fail(e) }
    },
  )

  /**
   * Text to speech — three model families, two endpoints:
   *   · MiniMax (minimax-speech-*), Fish (fish-s2.1-pro, fish-drama-3) and kling-tts run as async tasks on
   *     /v1/audio/generations and come back as a URL, like every other generation tool here.
   *   · ElevenLabs (eleven-tts-*) is only served by POST /v1/tts/stream, which answers with raw audio BYTES
   *     (/audio/generations rejects every eleven-tts-* id). Since 0.8.0 the bytes are uploaded to /v1/files
   *     so this tool still hands back a URL; the local server can also write them to save_to.
   * MiniMax requires an explicit voice_id (no server-side default), so one is filled in for MiniMax only.
   * Voice ids come from list_voices (GET /v1/voices/catalog).
   */
  server.tool(
    'text_to_speech',
    'Convert text to speech. Returns the audio file URL (valid 30 days). MiniMax (default, about $0.004 for a short line, $0.04 per 1000 characters), ElevenLabs eleven-tts-v3 / v4 / flash / turbo / multilingual (most natural, 70+ languages), Fish fish-s2.1-pro / fish-drama-3 (voice cloning library, expressive drama voices) and kling-tts. Find voices with list_voices.',
    {
      text: z.string().describe('The text to speak.'),
      model: z
        .string()
        .default('minimax-speech-02-turbo')
        .describe(
          'TTS model id: minimax-speech-02-turbo (fast), minimax-speech-02-hd, minimax-speech-2.6-hd, minimax-speech-2.8-hd / -turbo; eleven-tts-v3, eleven-tts-v4, eleven-tts-v4-turbo, eleven-tts-flash, eleven-tts-turbo, eleven-tts-multilingual; fish-s2.1-pro, fish-s2.1-pro-free, fish-drama-3; kling-tts.',
        ),
      voice_id: z
        .string()
        .optional()
        .describe(
          'Voice id from list_voices. MiniMax default English_Trustworthy_Man (others: English_Graceful_Lady, Serene_Woman, male-qn-qingse, female-tianmei). ElevenLabs default voice if omitted. Fish: pass the voice id here (sent as reference_id). kling-tts requires one.',
        ),
      speed: z.number().optional().describe('Optional speaking rate, about 0.5–2 (1 = normal).'),
      language_code: z.string().optional().describe('Optional ISO 639-1 language hint for ElevenLabs, e.g. en, zh, ja.'),
      save_to: z.string().optional().describe('Local server only, ElevenLabs only: also write the audio to this file path (e.g. ~/Desktop/line.mp3).'),
      extra: z.record(z.unknown()).optional().describe('Optional model-specific parameters passed through as-is, e.g. {"voice_settings": {"stability": 0.4}} for ElevenLabs, {"audio_setting": {...}} or {"language_boost": "Chinese"} for MiniMax.'),
      wait_seconds: waitSecondsParam('audio'),
    },
    { title: 'Text to speech', ...BILLABLE },
    async ({ text: tts, model, voice_id, speed, language_code, save_to, extra, wait_seconds }) => {
      try {
        const m = model.toLowerCase()
        if (m.startsWith('eleven-tts')) {
          const extraBody = extraParams(extra, ['model', 'text'])
          const voiceSettings = { ...((extraBody.voice_settings as Record<string, unknown>) || {}), ...(speed != null ? { speed } : {}) }
          const { buf, contentType } = await apiFetchBytes('/tts/stream', {
            ...extraBody,
            model,
            text: tts,
            ...(voice_id ? { voice_id } : {}),
            ...(language_code ? { language_code } : {}),
            ...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}),
          })
          const ext = contentType === 'audio/wav' ? 'wav' : 'mp3'
          const url = await uploadBytes(buf, `speech.${ext}`, contentType)
          let saved = ''
          if (save_to) {
            if (runtime.remote) throw new Error('save_to only works on the local server; use the URL instead.')
            const path = save_to.startsWith('~') ? join(homedir(), save_to.slice(1)) : save_to
            await writeFile(path, buf)
            saved = `\nSaved to ${path}`
          }
          return text(`${url}${saved}\n(${(buf.length / 1024).toFixed(0)} KB ${ext}; URL valid 30 days)`)
        }
        const isMinimax = m.startsWith('minimax-speech')
        const isFish = m.startsWith('fish-')
        const voice = voice_id || (isMinimax ? 'English_Trustworthy_Man' : undefined)
        if (m === 'kling-tts' && !voice) throw new Error('kling-tts needs voice_id — find one with list_voices.')
        const { taskId, state } = await submitAndWait('audio', {
          ...extraParams(extra, ['model', 'text']),
          model,
          text: tts,
          ...(voice && !isFish ? { voice_id: voice } : {}),
          ...(voice && isFish ? { reference_id: voice } : {}),
          ...(speed != null && isMinimax ? { voice_setting: { voice_id: voice, speed } } : {}),
          ...(speed != null && !isMinimax ? { speed } : {}),
        }, wait_seconds)
        return await taskResult(taskId, state, false)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'list_voices',
    'Search the voice library for text_to_speech: MiniMax, ElevenLabs and Fish voices with name, language, gender and a preview URL. Free. Pass the returned id as voice_id.',
    {
      provider: z.enum(['minimax', 'elevenlabs', 'fish']).optional().describe('Only voices for this TTS family (minimax-speech-*, eleven-tts-*, fish-*).'),
      language: z.string().optional().describe('ISO 639-1 language code, e.g. en, zh, ja, es.'),
      gender: z.string().optional().describe('e.g. male, female.'),
      q: z.string().optional().describe('Free-text search on name / description, e.g. "warm narrator" or "news".'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
      page_size: z.number().int().min(1).max(100).optional().describe('Results per page (default 20, max 100).'),
    },
    { title: 'List voices', ...READ_ONLY },
    async ({ provider, language, gender, q, page, page_size }) => {
      try {
        const qs = new URLSearchParams()
        if (provider) qs.set('provider', provider)
        if (language) qs.set('language', language)
        if (gender) qs.set('gender', gender)
        if (q) qs.set('q', q)
        if (page) qs.set('page', String(page))
        qs.set('page_size', String(page_size ?? 20))
        const res = await apiFetch(`/voices/catalog?${qs}`)
        return text(json(res?.data ?? res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'generate_audio',
    'Music, sound effects and audio processing on /v1/audio/generations: suno-v5 (songs with vocals or instrumental, from a description or your own lyrics), eleven-sfx-v3 and kling-sound-effects (sound effects from text), kling-video-to-audio (soundtrack for a video), eleven-dialogue (multi-speaker dialogue), eleven-dubbing (translate the speech in an audio / video file), eleven-isolator (strip background noise and music, keep the voice). For plain text-to-speech use text_to_speech. Returns the audio URL(s), valid 30 days; long jobs (music, dubbing) hand back a task id for get_task.',
    {
      model: z.string().describe('suno-v5, eleven-sfx-v3, kling-sound-effects, kling-video-to-audio, eleven-dialogue, eleven-dubbing or eleven-isolator. Call list_models for the full audio list.'),
      prompt: z.string().optional().describe('suno-v5: what the song should be about and sound like (the model writes the lyrics); with your own lyrics it is used as the style when tags is empty. Sound effects: describe the sound, e.g. "glass shattering on a tile floor".'),
      lyrics: z.string().optional().describe('suno-v5: your own lyrics (use write_lyrics to draft them). Leave out for lyrics written by the model.'),
      tags: z.string().optional().describe('suno-v5: style tags, e.g. "lo-fi hip hop, mellow, female vocals".'),
      title: z.string().optional().describe('suno-v5: song title.'),
      instrumental: z.boolean().optional().describe('suno-v5: true for no vocals.'),
      duration_seconds: z.number().optional().describe('Sound effects: length in seconds (eleven-sfx-v3).'),
      inputs: z.array(z.object({ text: z.string(), voice_id: z.string() })).optional().describe('eleven-dialogue: the lines in order, each { text, voice_id } (voices from list_voices provider "elevenlabs").'),
      audio_url: z.string().optional().describe('eleven-isolator: the audio to clean. Public URL, LOCAL FILE PATH, localhost URL or data: URI (local files up to 10 MB are uploaded for you).'),
      video_url: z.string().optional().describe('kling-video-to-audio: the video to add sound to. Same accepted forms; local videos up to 100 MB.'),
      source_url: z.string().optional().describe('eleven-dubbing: the audio or video whose speech to translate. Same accepted forms.'),
      target_lang: z.string().optional().describe('eleven-dubbing: target language code, e.g. es, ja, zh.'),
      source_lang: z.string().optional().describe('eleven-dubbing: source language code (optional, detected if omitted).'),
      extra: z.record(z.unknown()).optional().describe('Optional model-specific parameters passed through as-is, e.g. {"continue_clip_id": "…", "continue_at": 30} to extend a Suno song, {"num_speakers": 2} for dubbing, {"prompt_influence": 0.5} for sound effects. See apimodels.app/docs.'),
      wait_seconds: waitSecondsParam('audio'),
    },
    { title: 'Generate audio', ...BILLABLE },
    async ({ model, prompt, lyrics, tags, title, instrumental, duration_seconds, inputs, audio_url, video_url, source_url, target_lang, source_lang, extra, wait_seconds }) => {
      try {
        // Suno ignores `prompt`: its description mode reads `description` (lyrics written by the model) and its
        // custom mode reads lyrics + tags (style) — see the backend's suno-modes.ts. Map the one prompt field onto those.
        const suno = /^suno/i.test(model)
        const sunoStyle = suno && lyrics && !tags ? prompt : undefined
        const body: Record<string, unknown> = {
          ...extraParams(extra, ['model']),
          model,
          ...(prompt && !suno ? { prompt } : {}),
          ...(prompt && suno && !lyrics ? { description: prompt } : {}),
          ...(lyrics ? { lyrics } : {}),
          ...(tags || sunoStyle ? { tags: tags || sunoStyle } : {}),
          ...(title ? { title } : {}),
          ...(instrumental != null ? { instrumental } : {}),
          ...(duration_seconds != null ? { duration_seconds } : {}),
          ...(inputs?.length ? { inputs } : {}),
          ...(target_lang ? { target_lang } : {}),
          ...(source_lang ? { source_lang } : {}),
        }
        if (audio_url) body.audio_url = await resolveMediaInput(audio_url)
        if (video_url) body.video_url = await resolveMediaInput(video_url)
        if (source_url) body.source_url = await resolveMediaInput(source_url)
        const { taskId, state } = await submitAndWait('audio', body, wait_seconds)
        return await taskResult(taskId, state, false)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'write_lyrics',
    'Draft song lyrics (with a title and style tags) from a theme or a few keywords, to pass to generate_audio with model suno-v5. Free.',
    {
      prompt: z.string().describe('Theme or keywords, e.g. "a summer road trip with old friends, upbeat".'),
    },
    { title: 'Write lyrics', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ prompt }) => {
      try {
        const res = await apiFetch('/audio/lyrics', { method: 'POST', body: JSON.stringify({ prompt }) })
        const d = res?.data ?? {}
        return text(`TITLE: ${d.title || '(none)'}\nTAGS: ${d.tags || '(none)'}\n\n${d.lyric ?? json(res)}`)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'embed',
    'Turn text into embedding vectors (OpenAI-compatible /v1/embeddings) for semantic search, clustering or deduplication. Returns one vector per input. text-embedding-3-small: $0.018 per 1M tokens, 1536 dimensions; text-embedding-3-large: $0.059 per 1M tokens, 3072 dimensions.',
    {
      input: z.union([z.string(), z.array(z.string()).min(1).max(256)]).describe('One string, or a list of up to 256 strings.'),
      model: z.enum(['text-embedding-3-small', 'text-embedding-3-large']).default('text-embedding-3-small'),
      dimensions: z.number().int().min(1).max(3072).optional().describe('Optional: shorten the vectors to this many dimensions.'),
    },
    { title: 'Embed text', ...BILLABLE },
    async ({ input, model, dimensions }) => {
      try {
        const res = await apiFetch('/embeddings', { method: 'POST', body: JSON.stringify({ model, input, ...(dimensions ? { dimensions } : {}) }) })
        const vectors = (res?.data ?? []).map((d: any) => d.embedding)
        return text(json({ model: res?.model ?? model, dimensions: vectors[0]?.length ?? 0, usage: res?.usage, embeddings: vectors }))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'extract_media',
    'Get the direct media links behind a social-media post or page (YouTube, TikTok, Instagram, Facebook, X, Xiaohongshu, Bilibili, Weibo, Douyin and 1000+ other sites; short links work): video / image / audio URLs plus caption and author. op "post" ($0.004) reads one post; "playlist" ($0.02 a page) lists a profile, channel, playlist or topic, with next_cursor for the next page; "subtitles" ($0.004) returns YouTube / Bilibili subtitles; "youtube_download" ($0.012) returns a temporary download link (up to 1080p, valid about an hour). Only process media the user has the right to use. Failed calls are not billed.',
    {
      url: z.string().describe('The post, profile, channel or video page URL.'),
      op: z.enum(['post', 'playlist', 'subtitles', 'youtube_download']).default('post'),
      cursor: z.string().optional().describe('playlist only: the next_cursor from the previous page.'),
    },
    { title: 'Extract media', ...BILLABLE },
    async ({ url, op, cursor }) => {
      try {
        const path = { post: '/media/extract', playlist: '/media/playlist', subtitles: '/media/subtitles', youtube_download: '/media/youtube-download' }[op]
        const res = await apiFetch(path, { method: 'POST', body: JSON.stringify({ url, ...(op === 'playlist' && cursor ? { cursor } : {}) }) })
        return text(json(res?.data ?? res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'jev_decide',
    'Jev (TypeSafe System One): a decision model, not a chat model. Give it a state (text or JSON) and typed questions; it returns an answer with probabilities for each — use it to classify, route, score or check a claim with calibrated confidence. Question types: "choice" (instructions + criteria: {option: description}), "score" (instructions, scored on a scale) and "noul" (instructions = a statement; returns the probability it is true). $0.05 per 1M input tokens, output free.',
    {
      state: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).describe('What to decide about: text, or a JSON object / array.'),
      questions: z.record(z.object({ type: z.enum(['choice', 'score', 'noul']) }).passthrough()).describe('Questions keyed by your own ids, e.g. {"queue": {"type": "choice", "instructions": "Which queue?", "criteria": {"billing": "Payments and refunds", "bug": "Something is broken"}}, "urgent": {"type": "noul", "instructions": "The customer needs a reply within the hour."}}'),
    },
    { title: 'Jev decide', ...BILLABLE },
    async ({ state, questions }) => {
      try {
        const res = await apiFetch('/systemone', { method: 'POST', body: JSON.stringify({ model: 'jev', state, questions }) })
        return text(json(res))
      } catch (e) { return fail(e) }
    },
  )

  /**
   * Asset library (/v1/assets): registers an image, video or audio file as an asset:// reference, $0.01 each.
   * Seedance accepts real-person images directly (a moderation rejection triggers an automatic asset retry),
   * so an asset is only needed to reuse a fixed person or product across many tasks. Assets live in groups
   * that belong to one API key; upload_asset uses (or creates) a group called "mcp" unless given group_id.
   */
  const MCP_ASSET_GROUP = 'mcp'
  async function assetGroupId(groupId?: number): Promise<number> {
    if (groupId) return groupId
    const groups = await apiFetch('/assets/groups')
    const found = (groups?.data ?? []).find((g: any) => g?.name === MCP_ASSET_GROUP)
    if (found?.id) return Number(found.id)
    const created = await apiFetch('/assets/groups', { method: 'POST', body: JSON.stringify({ name: MCP_ASSET_GROUP }) })
    const id = Number(created?.data?.id)
    if (!id) throw new Error(`Could not create the asset group: ${json(created)}`)
    return id
  }

  server.tool(
    'upload_asset',
    'Upload an image, video or audio file to your asset library and get an asset:// reference to pass to video models (reference_image_urls, image_url, reference_video_urls, …), e.g. to keep the same real person or product across many Seedance clips. $0.01 per asset. Seedance already accepts plain image URLs (and retries rejected real-person images through the library automatically), so register an asset only to reuse a subject. Use only with consented subjects.',
    {
      source: z.string().describe('The file: public https:// URL, LOCAL FILE PATH, localhost URL or data: URI (local files are uploaded for you: images and audio up to 10 MB, video up to 100 MB).'),
      asset_type: z.enum(['Image', 'Video', 'Audio']).optional().describe('Detected from the file extension when omitted.'),
      name: z.string().max(64).optional().describe('Optional name, to find it again with list_assets.'),
      group_id: z.number().int().positive().optional().describe('Optional asset group id (list_assets shows them). Default: a group named "mcp", created on first use.'),
    },
    { title: 'Upload asset', ...BILLABLE },
    async ({ source, asset_type, name, group_id }) => {
      try {
        const type = asset_type || assetTypeOf(source)
        if (!type) throw new Error('Could not tell the file type from its name — pass asset_type (Image, Video or Audio).')
        const url = await resolveMediaInput(source)
        const gid = await assetGroupId(group_id)
        const res = await apiFetch('/assets', { method: 'POST', body: JSON.stringify({ url, asset_type: type, group_id: gid, ...(name ? { name } : {}) }) })
        const d = res?.data ?? {}
        const ready = d.status === 'Active'
        return text(`${d.asset_url ?? json(res)}\nid ${d.id} · ${type} · group ${gid} · status ${d.status}${ready ? '' : ' — still processing; call get_asset with this id until it is Active before using it'}`)
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'list_assets',
    'List the asset groups and assets in your library (for the API key in use), with id, asset:// reference, type, name and status. Free.',
    {
      group_id: z.number().int().positive().optional().describe('Only this group.'),
      name: z.string().optional().describe('Filter by name (partial match).'),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional().describe('Default 20, max 100.'),
    },
    { title: 'List assets', ...READ_ONLY },
    async ({ group_id, name, page, page_size }) => {
      try {
        const [groups, assets] = await Promise.all([
          apiFetch('/assets/groups'),
          apiFetch('/assets/list', { method: 'POST', body: JSON.stringify({ page_number: page ?? 1, page_size: page_size ?? 20, ...(group_id ? { group_id } : {}), ...(name ? { name } : {}) }) }),
        ])
        return text(json({ groups: groups?.data ?? groups, assets: assets?.data ?? assets }))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'get_asset',
    'Look up one asset: its status (Processing → Active, or Failed), asset:// reference, and a signed preview URL valid 12 hours. Free.',
    { id: z.string().describe('Asset id from upload_asset or list_assets.') },
    { title: 'Get asset', ...READ_ONLY },
    async ({ id }) => {
      try {
        const res = await apiFetch('/assets/get', { method: 'POST', body: JSON.stringify({ id }) })
        return text(json(res?.data ?? res))
      } catch (e) { return fail(e) }
    },
  )

  server.tool(
    'delete_asset',
    'Delete one asset from the library. Tasks that already used it are unaffected, but the asset:// reference stops working for new tasks. Cannot be undone — confirm with the user first.',
    { id: z.string().describe('Asset id from upload_asset or list_assets.') },
    { title: 'Delete asset', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ id }) => {
      try {
        const res = await apiFetch('/assets/delete', { method: 'POST', body: JSON.stringify({ id }) })
        return text(`Deleted asset ${res?.data?.id ?? id}.`)
      } catch (e) { return fail(e) }
    },
  )

  if (runtime.remote) {
    server.tool(
      'get_upload_url',
      'Hosted server only. When the image or video the user wants to use is a file on their machine, call this, run the returned curl command in their shell, and pass the "url" it prints as image_url (or any other input URL). The link works for 15 minutes and only uploads; it cannot spend credits.',
      {
        filename: z.string().describe('The file name with extension, e.g. photo.png or clip.mp4 — used to set the file type.'),
      },
      { title: 'Get upload URL', ...READ_ONLY },
      async ({ filename }) => {
        try {
          const name = basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'upload.bin'
          const base = (process.env.MCP_PUBLIC_URL || '').replace(/\/$/, '')
          const url = `${base}/upload/${makeUploadToken(requireKey())}?name=${encodeURIComponent(name)}`
          return text(`Upload link (valid ${UPLOAD_TTL_MS / 60_000} minutes):\n${url}\n\nRun:\ncurl -sS -T "<path to ${name}>" "${url}"\n\nIt prints {"url": "https://…"} — pass that URL to the generation tool.`)
        } catch (e) { return fail(e) }
      },
    )
  }

  return server
}

async function main() {
  if (!resolveKey()) console.error(`[apimodels-mcp] warning: ${NO_KEY_MSG}`)
  const transport = new StdioServerTransport()
  await buildServer().connect(transport)
  console.error('[apimodels-mcp] ready (stdio). Base URL:', BASE_URL)
}

// `apimodels-mcp login | logout | status` — a terminal command, not the server.
// APIMODELS_MCP_NO_MAIN=1 imports the module without starting anything (scripts/selftest.mjs).
const cmd = process.argv[2]
if (process.env.APIMODELS_MCP_NO_MAIN === '1') {
  // test harness: buildServer() only
} else if (cmd === 'serve') {
  // Hosted mode: `apimodels-mcp serve [--port 8095]` (env MCP_PUBLIC_URL, MCP_AUTH_SERVER, MCP_UPLOAD_SECRET, MCP_HOST)
  runtime.remote = true
  runtime.waitCap = REMOTE_WAIT_CAP_S
  const i = process.argv.indexOf('--port')
  const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT) || 8095
  process.env.MCP_PUBLIC_URL ||= `http://localhost:${port}`
  import('./http.js').then(({ serve }) => serve({ buildServer, requestKey, apiBaseUrl: BASE_URL, uploadBytes, guessMime }, port)).catch((e) => {
    console.error('[apimodels-mcp] fatal:', e)
    process.exit(1)
  })
} else if (cmd && CLI_COMMANDS.has(cmd)) {
  runCli(cmd, process.argv.slice(3), BASE_URL).then((code) => process.exit(code), (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
} else {
  main().catch((e) => {
    console.error('[apimodels-mcp] fatal:', e)
    process.exit(1)
  })
}

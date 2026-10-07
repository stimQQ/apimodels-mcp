#!/usr/bin/env node
/**
 * apimodels-mcp — Model Context Protocol server for apimodels.app
 *
 * Exposes image / video / chat / text-to-speech generation as MCP tools so any
 * MCP client (Claude Desktop, Cursor, …) can call every apimodels model with a
 * single API key.
 *
 * Config (environment variables):
 *   APIMODELS_API_KEY       (required)  your sk_… key from https://apimodels.app/console/api-keys
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

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const API_KEY = process.env.APIMODELS_API_KEY
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
// when a tool actually needs the API (requireKey below).
const NO_KEY_MSG = 'APIMODELS_API_KEY is not set. Get a key at https://apimodels.app/console/api-keys and add it to this server\'s environment.'
if (!API_KEY) console.error(`[apimodels-mcp] warning: ${NO_KEY_MSG}`)

function requireKey(): string {
  if (!API_KEY) throw new Error(NO_KEY_MSG)
  return API_KEY
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
    const msg = json?.msg || json?.error?.message || json?.error || text || `HTTP ${res.status}`
    throw new Error(`apimodels API error (HTTP ${res.status}): ${msg}`)
  }
  return json
}

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
 * Passes public http(s) URLs straight through untouched.
 */
async function resolveImageInput(input: string): Promise<string> {
  const raw = input.trim()

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

    // Reachable from here (this process is on the user's machine), not from ours.
    const res = await fetch(raw)
    if (!res.ok) throw new Error(`Could not read ${raw} from this machine (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'input.png')
    return uploadBytes(buf, name, res.headers.get('content-type') || guessMime(name))
  }

  // Anything else is treated as a filesystem path (absolute, relative, or ~).
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

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || ''
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic' } as Record<string, string>)[ext] || 'image/png'
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

/** Submit an async generation and return its task id. Billing happens on completion, not here. */
async function submitTask(kind: Kind, body: Record<string, unknown>): Promise<string> {
  const created = await apiFetch(`/${kind}/generations`, { method: 'POST', body: JSON.stringify(body) })
  const taskId: string | undefined = created?.data?.taskId
  if (!taskId) throw new Error(`No taskId returned: ${JSON.stringify(created)}`)
  return taskId
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
  const deadline = Date.now() + waitS * 1000
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
    `Next: call get_task with task_id "${taskId}" (it waits up to wait_seconds, default ${DEFAULT_WAIT_S}). Do NOT submit the job again — this task keeps running, is billed once when it completes, and its result stays retrievable for 7 days.`,
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
  z.number().int().min(0).max(MAX_WAIT_S).default(DEFAULT_WAIT_S).describe(
    `How long to wait for the ${what} before returning a task id instead (seconds, 0–${MAX_WAIT_S}). Default ${DEFAULT_WAIT_S}: Codex aborts tool calls at 60 s unless tool_timeout_sec is raised. In Claude Code / Claude Desktop you can pass up to ${MAX_WAIT_S} to get the URL in one call.`,
  )

const server = new McpServer({ name: 'apimodels-mcp', version: '0.4.2' })

server.tool(
  'list_models',
  'List the model ids available on apimodels.app, grouped by type (chat, image, video, audio, embedding) with the endpoint each one uses. Every id listed is callable. Use chat ids with chat, image ids with generate_image, video ids with generate_video, audio ids with text_to_speech.',
  {},
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
  'Chat / text completion with any LLM on apimodels.app (GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, …). Returns the assistant reply text.',
  {
    prompt: z.string().describe('The user message / prompt.'),
    model: z.string().default('gpt-5-5').describe('Model id, e.g. gpt-5-5, gpt-6.1-sol, gpt-6-sol, claude-opus-5-5, claude-sonnet-5-5 (Claude Sonnet 5.5, fast and strong at coding and agent work, $1.20 / $6 per 1M tokens), claude-sonnet-5, gemini-3-pro-preview, deepseek-v4-pro. Call list_models for the full list.'),
    system: z.string().optional().describe('Optional system prompt.'),
    max_tokens: z.number().int().positive().optional().describe('Optional max output tokens.'),
  },
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
  'Generate an image from a text prompt (or edit an input image). Returns the URL(s) of the generated image, valid 7 days, plus a downscaled preview of the image itself when the client can show tool-result images to you. Images take about 50 s (9 in 10 within 90 s); if the task is still running when wait_seconds is up you get a task id — call get_task with it, do not resubmit. If you cannot see the image in the result, call review_image with the returned URL to get a written critique and a revised prompt, then generate again. Roughly $0.025 per image on the default model; gpt-image-2-lite is $0.008.',
  {
    prompt: z.string().optional().describe('Text description of the image to generate (or the edit to make). Required, except with layer_decomposition where it is optional.'),
    model: z.string().default('gpt-image-2').describe('Image model id, e.g. gpt-image-2, gpt-image-2.5-flare, flux-2-klein-4b ($0.006, fastest, up to 3 reference images), gpt-image-2-lite, gemini-3-pro-image, gemini-3-pro-image-gemini ($0.03 flat), qwen3-image (small in-image text), gemini-3.1-flash-image, nano-banana-2-1 (Google Nano Banana 2.1: $0.024 1K / $0.04 2K / $0.064 4K, accurate in-image text, 15 aspect ratios incl. 21:9 and 1:8), doubao-seedream-5-0-flash ($0.03, fast, 1K/2K; supports background and layer_decomposition), doubao-seedream-5-0-pro ($0.03 1K / $0.06 2K, precise region edits).'),
    aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 1:1, 16:9, 9:16.'),
    resolution: z.string().optional().describe('Optional resolution, e.g. 1K, 2K, 4K.'),
    image_url: z.string().optional().describe('Optional input image for image-to-image edits. Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI — local sources are uploaded for you automatically.'),
    background: z.enum(['transparent']).optional().describe('Set to "transparent" to edit an image that already has a transparent background and keep it transparent (PNG with alpha out). Needs image_url pointing at ONE PNG with an alpha channel. doubao-seedream-5-0-flash or doubao-seedream-5-0-pro only.'),
    layer_decomposition: z.boolean().optional().describe('Split the image in image_url into a flattened base plus up to 16 transparent PNG layers (text blocks, subjects, props), each returned with a name and its box in the original. prompt is optional. Billed $0.03 per output image, so tell the user the cost depends on how many layers come back (at most $0.51). doubao-seedream-5-0-flash only.'),
    return_image: z.boolean().default(true).describe('Attach a downscaled preview (max 1024px JPEG) of the result so you can look at it. Set false to save context when you only need the URL.'),
    wait_seconds: waitSecondsParam('image'),
  },
  async ({ prompt, model, aspect_ratio, resolution, image_url, background, layer_decomposition, return_image, wait_seconds }) => {
    try {
      if (!prompt && !layer_decomposition) throw new Error('prompt is required (it is optional only with layer_decomposition).')
      if ((background || layer_decomposition) && !image_url) throw new Error(`${layer_decomposition ? 'layer_decomposition' : 'background'} needs image_url: exactly one input image.`)
      const taskId = await submitTask('images', {
        model,
        ...(prompt ? { prompt } : {}),
        ...(background ? { background } : {}),
        ...(layer_decomposition ? { layer_decomposition: true } : {}),
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(image_url ? { image_url: await resolveImageInput(image_url) } : {}),
      })
      return await taskResult(taskId, await pollTask('images', taskId, wait_seconds), return_image)
    } catch (e) { return fail(e) }
  },
)

server.tool(
  'review_image',
  'Have a vision model look at an image and critique it against a brief. Returns what matches, what is wrong (garbled text, composition, colors, artifacts) and a revised prompt. Use it after generate_image to check the result and decide whether to regenerate — this works in every MCP client, including ones that do not pass tool-result images to you. Costs one small vision chat call (well under $0.01 on the default model).',
  {
    image_url: z.string().describe('The image to review: a URL returned by generate_image, any public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI.'),
    brief: z.string().describe('What the image is supposed to show — usually the prompt it was generated from, plus any requirements the user stated (exact text, aspect ratio, style).'),
    model: z.string().default('gpt-5.6-luna').describe('Vision-capable chat model that does the looking. gpt-5.6-luna (default, cheapest) or claude-sonnet-5 for a more careful read.'),
  },
  async ({ image_url, brief, model }) => {
    try {
      const url = await resolveImageInput(image_url)
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
  'Generate a video from a text prompt (and optional reference image). Submits the job and waits up to wait_seconds: returns the video URL(s) (valid 7 days) if it finishes in time, otherwise a task id — then call get_task with that id; never resubmit a running task. Video takes a median 2.5 minutes and 9 in 10 finish within 8 minutes, so expect one or two get_task calls. Video is the most expensive modality here — the default model costs roughly $0.30-$0.50 per clip; pass model:"veo-3.1-fast-fhd" for the cheapest option at $0.07 flat.',
  {
    prompt: z.string().describe('Text description of the video.'),
    model: z.string().default('seedance-2.0-fast').describe('Video model id. Use the dotted public names: seedance-2.0-fast, seedance-2.0, seedance-2.0-mini, seedance-2.5, wan-3.0-video, minimax-h3, minimax-h3-lite (low cost, up to 768p), ltx-2.3, grok-imagine-video-1.5, veo-3.1-fast-fhd ($0.07 flat), veo-3.1, kling-v2-6. Call list_models for the full list.'),
    aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 16:9, 9:16, 1:1.'),
    resolution: z.string().optional().describe('Optional resolution, e.g. 480p, 720p, 1080p.'),
    duration: z.union([z.number(), z.string()]).optional().describe('Optional duration in seconds, e.g. 5 or 10.'),
    image_url: z.string().optional().describe('Optional first-frame / reference image for image-to-video. Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI — local sources are uploaded for you automatically.'),
    wait_seconds: waitSecondsParam('video'),
  },
  async ({ prompt, model, aspect_ratio, resolution, duration, image_url, wait_seconds }) => {
    try {
      const taskId = await submitTask('video', {
        model, prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(duration != null ? { duration } : {}),
        ...(image_url ? { images: [await resolveImageInput(image_url)] } : {}),
      })
      return await taskResult(taskId, await pollTask('video', taskId, wait_seconds), false)
    } catch (e) { return fail(e) }
  },
)

server.tool(
  'get_task',
  'Check on, or wait for, an image / video / speech task that generate_image, generate_video or text_to_speech handed back as "still running". Returns the result URL(s) once it has finished (with an image preview for image tasks), a failure message if it failed, or "still running" again — in which case call get_task once more. Waits up to wait_seconds before answering, so one call usually suffices for a task that is nearly done. Task ids also appear at https://apimodels.app/console/records.',
  {
    task_id: z.string().describe('The task id from the "STILL RUNNING" message (or from the apimodels console).'),
    wait_seconds: waitSecondsParam('task'),
    return_image: z.boolean().default(true).describe('For image tasks, attach a downscaled preview of the result. Set false to save context.'),
  },
  async ({ task_id, wait_seconds, return_image }) => {
    try {
      // Lookup is by id alone server-side; the endpoint only names a default kind for the timing hints.
      return await taskResult(task_id, await pollTask('video', task_id.trim(), wait_seconds), return_image)
    } catch (e) { return fail(e) }
  },
)

/**
 * Text to speech.
 *
 * This tool used to default to `eleven-tts-v3` against `/audio/generations`, which
 * cannot work: the ElevenLabs TTS models are served by `POST /v1/tts/stream`, and
 * `/audio/generations` rejects every `eleven-tts-*` id outright
 * ("Invalid model: eleven-tts-v3. Supported: kling-…, eleven-dialogue, …"). Every
 * call 400'd.
 *
 * Of the two ways out, this tool stays on `/audio/generations` and moves to a model
 * that endpoint actually serves. `/v1/tts/stream` returns raw audio BYTES, so an MCP
 * server pointed at it has no URL to hand back — it would have to write a file and
 * change what this tool returns, diverging from generate_image / generate_video.
 * `/audio/generations` keeps the async-task-to-URL shape the rest of the server uses
 * and takes exactly the parameters declared below.
 *
 * MiniMax requires an explicit voice_id (there is no server-side default), so one is
 * baked in here — without it the "default path" would still fail, just with a
 * different message. Voice ids come from GET /v1/minimax/voices.
 */
server.tool(
  'text_to_speech',
  'Convert text to speech (MiniMax voices). Returns the audio file URL (valid 7 days). Costs about $0.004 for a short line; billed at $0.04 per 1000 characters.',
  {
    text: z.string().describe('The text to speak.'),
    model: z
      .string()
      .default('minimax-speech-02-turbo')
      .describe(
        'TTS model id, e.g. minimax-speech-02-turbo (fast), minimax-speech-02-hd / minimax-speech-2.8-hd (higher quality). Note: eleven-tts-* models are NOT available here — they stream from POST /v1/tts/stream instead.',
      ),
    voice_id: z
      .string()
      .default('English_Trustworthy_Man')
      .describe(
        'Voice id. English: English_Trustworthy_Man, English_Graceful_Lady, Serene_Woman. Chinese: male-qn-qingse, female-tianmei. Full list: GET /v1/minimax/voices.',
      ),
    speed: z.number().optional().describe('Optional speaking rate, 0.5-2 (1 = normal).'),
    wait_seconds: waitSecondsParam('audio'),
  },
  async ({ text: tts, model, voice_id, speed, wait_seconds }) => {
    try {
      const taskId = await submitTask('audio', {
        model,
        text: tts,
        voice_id,
        ...(speed != null ? { voice_setting: { voice_id, speed } } : {}),
      })
      return await taskResult(taskId, await pollTask('audio', taskId, wait_seconds), false)
    } catch (e) { return fail(e) }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[apimodels-mcp] ready (stdio). Base URL:', BASE_URL)
}

main().catch((e) => {
  console.error('[apimodels-mcp] fatal:', e)
  process.exit(1)
})

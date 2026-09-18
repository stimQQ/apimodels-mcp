#!/usr/bin/env node
/**
 * apimodels-mcp — Model Context Protocol server for apimodels.app
 *
 * Exposes image / video / chat / text-to-speech generation as MCP tools so any
 * MCP client (Claude Desktop, Cursor, …) can call every apimodels model with a
 * single API key.
 *
 * Config (environment variables):
 *   APIMODELS_API_KEY   (required)  your sk_… key from https://apimodels.app/console/api-keys
 *   APIMODELS_BASE_URL  (optional)  default https://api.apimodels.app/v1
 *   APIMODELS_TIMEOUT_MS(optional)  max ms to poll an async (image/video/audio) task, default 300000
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const API_KEY = process.env.APIMODELS_API_KEY
const BASE_URL = (process.env.APIMODELS_BASE_URL || 'https://api.apimodels.app/v1').replace(/\/$/, '')
const POLL_TIMEOUT_MS = Number(process.env.APIMODELS_TIMEOUT_MS) || 300_000
const POLL_INTERVAL_MS = 3_000

if (!API_KEY) {
  console.error('[apimodels-mcp] APIMODELS_API_KEY is not set. Get one at https://apimodels.app/console/api-keys')
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
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
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  })
  const json: any = await res.json().catch(() => ({}))
  const url = json?.data?.publicUrl
  if (!res.ok || !url) {
    throw new Error(`Upload of ${filename} failed: ${json?.msg || `HTTP ${res.status}`}`)
  }
  return url
}

/** Submit an async generation (image/video/audio), then poll until it finishes. */
async function runAsyncTask(kind: 'images' | 'video' | 'audio', body: Record<string, unknown>): Promise<string[]> {
  const created = await apiFetch(`/${kind}/generations`, { method: 'POST', body: JSON.stringify(body) })
  const taskId: string | undefined = created?.data?.taskId
  if (!taskId) throw new Error(`No taskId returned: ${JSON.stringify(created)}`)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const polled = await apiFetch(`/${kind}/generations?task_id=${encodeURIComponent(taskId)}`)
    const state: string = polled?.data?.state
    if (state === 'completed') {
      const urls: string[] = polled?.data?.resultUrls || []
      if (!urls.length) throw new Error('Task completed but returned no result URLs')
      return urls
    }
    if (state === 'failed') {
      throw new Error(`Generation failed: ${polled?.data?.failMsg || polled?.data?.failCode || 'unknown error'}`)
    }
  }
  throw new Error(`Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s (task ${taskId} still running). Results stay retrievable via the dashboard.`)
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

const server = new McpServer({ name: 'apimodels-mcp', version: '0.2.1' })

server.tool(
  'list_models',
  'List the model ids available on apimodels.app (chat, image, video, audio). Use the returned ids with the other tools. Caveat: a handful of entries are internal names that the generation endpoints reject (e.g. seedance-2-fast, seedance-2, motion-control) — the public alias is the dotted form, e.g. seedance-2.0-fast. If an id comes back "Invalid model", try the dotted variant before giving up.',
  {},
  async () => {
    try {
      const res = await apiFetch('/models')
      const ids = (res?.data || []).map((m: any) => m.id).filter(Boolean)
      return text(ids.length ? ids.join('\n') : JSON.stringify(res))
    } catch (e) { return fail(e) }
  },
)

server.tool(
  'chat',
  'Chat / text completion with any LLM on apimodels.app (GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, …). Returns the assistant reply text.',
  {
    prompt: z.string().describe('The user message / prompt.'),
    model: z.string().default('gpt-5-5').describe('Model id, e.g. gpt-5-5, claude-opus-4-8, claude-sonnet-4-6, gemini-3-pro-preview, deepseek-v4-pro.'),
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
  'Generate an image from a text prompt (or edit an input image). Returns the URL(s) of the generated image, valid 7 days, plus a downscaled preview of the image itself when the client can show tool-result images to you. If you cannot see the image in the result, call review_image with the returned URL to get a written critique and a revised prompt, then generate again. Roughly $0.025 per image on the default model; gpt-image-2-lite is $0.008.',
  {
    prompt: z.string().describe('Text description of the image to generate.'),
    model: z.string().default('gpt-image-2').describe('Image model id, e.g. gpt-image-2, gpt-image-2-lite (cheapest), gemini-3-pro-image, gemini-2.5-flash-image, doubao-seedream-4-5-251128.'),
    aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 1:1, 16:9, 9:16.'),
    resolution: z.string().optional().describe('Optional resolution, e.g. 1K, 2K, 4K.'),
    image_url: z.string().optional().describe('Optional input image for image-to-image edits. Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI — local sources are uploaded for you automatically.'),
    return_image: z.boolean().default(true).describe('Attach a downscaled preview (max 1024px JPEG) of the result so you can look at it. Set false to save context when you only need the URL.'),
  },
  async ({ prompt, model, aspect_ratio, resolution, image_url, return_image }) => {
    try {
      const urls = await runAsyncTask('images', {
        model, prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(image_url ? { image_url: await resolveImageInput(image_url) } : {}),
      })
      const previews = return_image ? await Promise.all(urls.slice(0, 2).map(imagePreview)) : []
      return {
        content: [
          { type: 'text' as const, text: urls.join('\n') },
          ...previews.flatMap((p) => (p ? [{ type: 'image' as const, data: p.data, mimeType: p.mimeType }] : [])),
        ],
      }
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
  'Generate a video from a text prompt (and optional reference image). Polls until done and returns the video URL(s), valid 7 days. May take a few minutes. Video is the most expensive modality here — the default model costs roughly $0.30-$0.50 per clip; pass model:"veo-3.1-fast-fhd" for the cheapest option at $0.07 flat.',
  {
    prompt: z.string().describe('Text description of the video.'),
    model: z.string().default('seedance-2.0-fast').describe('Video model id. Use the dotted public names: seedance-2.0-fast, seedance-2.0, seedance-2.5, veo-3.1-fast-fhd ($0.07 flat, cheapest), veo-3.1, grok-video-3, kling-v2-6, minimax-h3. The bare forms seedance-2-fast / seedance-2 are internal names and will 400.'),
    aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 16:9, 9:16, 1:1.'),
    resolution: z.string().optional().describe('Optional resolution, e.g. 480p, 720p, 1080p.'),
    duration: z.union([z.number(), z.string()]).optional().describe('Optional duration in seconds, e.g. 5 or 10.'),
    image_url: z.string().optional().describe('Optional first-frame / reference image for image-to-video. Accepts a public https:// URL, a LOCAL FILE PATH, a localhost URL, or a data: URI — local sources are uploaded for you automatically.'),
  },
  async ({ prompt, model, aspect_ratio, resolution, duration, image_url }) => {
    try {
      const urls = await runAsyncTask('video', {
        model, prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(duration != null ? { duration } : {}),
        ...(image_url ? { images: [await resolveImageInput(image_url)] } : {}),
      })
      return text(urls.join('\n'))
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
  },
  async ({ text: tts, model, voice_id, speed }) => {
    try {
      const urls = await runAsyncTask('audio', {
        model,
        text: tts,
        voice_id,
        ...(speed != null ? { voice_setting: { voice_id, speed } } : {}),
      })
      return text(urls.join('\n'))
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

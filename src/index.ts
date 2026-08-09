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
 *   APIMODELS_BASE_URL  (optional)  default https://apimodels.app/api/v1
 *   APIMODELS_TIMEOUT_MS(optional)  max ms to poll an async (image/video/audio) task, default 300000
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API_KEY = process.env.APIMODELS_API_KEY
const BASE_URL = (process.env.APIMODELS_BASE_URL || 'https://apimodels.app/api/v1').replace(/\/$/, '')
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

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true })

const server = new McpServer({ name: 'apimodels-mcp', version: '0.1.0' })

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
  'Generate an image from a text prompt (or edit an input image). Returns the URL(s) of the generated image, valid 7 days. Roughly $0.025 per image on the default model; gpt-image-2-lite is $0.008.',
  {
    prompt: z.string().describe('Text description of the image to generate.'),
    model: z.string().default('gpt-image-2').describe('Image model id, e.g. gpt-image-2, gpt-image-2-lite (cheapest), gemini-3-pro-image, gemini-2.5-flash-image, doubao-seedream-4-5-251128.'),
    aspect_ratio: z.string().optional().describe('Optional aspect ratio, e.g. 1:1, 16:9, 9:16.'),
    resolution: z.string().optional().describe('Optional resolution, e.g. 1K, 2K, 4K.'),
    image_url: z.string().optional().describe('Optional input image URL for image-to-image edits.'),
  },
  async ({ prompt, model, aspect_ratio, resolution, image_url }) => {
    try {
      const urls = await runAsyncTask('images', {
        model, prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(image_url ? { image_url } : {}),
      })
      return text(urls.join('\n'))
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
    image_url: z.string().optional().describe('Optional first-frame / reference image URL for image-to-video.'),
  },
  async ({ prompt, model, aspect_ratio, resolution, duration, image_url }) => {
    try {
      const urls = await runAsyncTask('video', {
        model, prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(duration != null ? { duration } : {}),
        ...(image_url ? { images: [image_url] } : {}),
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

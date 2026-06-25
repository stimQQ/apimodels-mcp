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
  'List the model ids available on apimodels.app (chat, image, video, audio). Use the returned ids with the other tools.',
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
    model: z.string().default('gpt-5-5').describe('Model id, e.g. gpt-5-5, claude-opus-4-8, gemini-3-pro-preview, deepseek-v4-pro.'),
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
  'Generate an image from a text prompt (or edit an input image). Returns the URL(s) of the generated image.',
  {
    prompt: z.string().describe('Text description of the image to generate.'),
    model: z.string().default('gpt-image-2').describe('Image model id, e.g. gpt-image-2, gemini-3-pro-image-preview, gemini-2.5-flash-image.'),
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
  'Generate a video from a text prompt (and optional reference image). Polls until done and returns the video URL(s). May take a few minutes.',
  {
    prompt: z.string().describe('Text description of the video.'),
    model: z.string().default('seedance-2-fast').describe('Video model id, e.g. seedance-2-fast, seedance-2, veo3.1-4k, grok-video-3.'),
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

server.tool(
  'text_to_speech',
  'Convert text to speech (ElevenLabs / MiniMax voices). Returns the audio file URL.',
  {
    text: z.string().describe('The text to speak.'),
    model: z.string().default('eleven-tts-v3').describe('TTS model id, e.g. eleven-tts-v3, eleven-tts-v2.'),
    voice_id: z.string().optional().describe('Optional voice id (omit for the model default).'),
  },
  async ({ text: tts, model, voice_id }) => {
    try {
      const urls = await runAsyncTask('audio', {
        model, text: tts,
        ...(voice_id ? { voice_id } : {}),
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

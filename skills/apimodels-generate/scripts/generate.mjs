#!/usr/bin/env node
/**
 * apimodels-generate — generate images, videos, or speech via apimodels.app.
 *
 * Usage:
 *   APIMODELS_API_KEY=sk_... node generate.mjs --type image --prompt "a red fox" [--model gpt-image-2] [--aspect_ratio 1:1]
 *   APIMODELS_API_KEY=sk_... node generate.mjs --type video --prompt "a city timelapse" [--model seedance-2.0-fast] [--resolution 720p] [--duration 5]
 *   APIMODELS_API_KEY=sk_... node generate.mjs --type tts   --text   "hello world"  [--model minimax-speech-02-turbo] [--voice_id ...]
 *
 * Model-name gotchas (both were live bugs here):
 *   - video: the public names are dotted — `seedance-2.0-fast`, not `seedance-2-fast`.
 *     The bare form is an internal name and the endpoint answers "Invalid model".
 *   - tts: `/audio/generations` does NOT serve the `eleven-tts-*` models; those stream
 *     from POST /v1/tts/stream instead. Use a minimax-speech-* model here, and note
 *     MiniMax requires an explicit voice_id (GET /v1/minimax/voices lists them).
 *
 * Prints the resulting URL(s) to stdout, one per line.
 */

const BASE_URL = (process.env.APIMODELS_BASE_URL || 'https://apimodels.app/api/v1').replace(/\/$/, '')
const API_KEY = process.env.APIMODELS_API_KEY
const TIMEOUT_MS = Number(process.env.APIMODELS_TIMEOUT_MS) || 300_000

if (!API_KEY) {
  console.error('APIMODELS_API_KEY is not set. Get one at https://apimodels.app/console/api-keys')
  process.exit(1)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      out[key] = val
    }
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function apiFetch(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const txt = await res.text()
  let json; try { json = txt ? JSON.parse(txt) : {} } catch { json = { raw: txt } }
  if (!res.ok) throw new Error(`API error HTTP ${res.status}: ${json?.msg || json?.error?.message || txt}`)
  return json
}

async function runAsyncTask(kind, body) {
  const created = await apiFetch(`/${kind}/generations`, { method: 'POST', body: JSON.stringify(body) })
  const taskId = created?.data?.taskId
  if (!taskId) throw new Error(`No taskId returned: ${JSON.stringify(created)}`)
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(3000)
    const polled = await apiFetch(`/${kind}/generations?task_id=${encodeURIComponent(taskId)}`)
    const state = polled?.data?.state
    if (state === 'completed') {
      const urls = polled?.data?.resultUrls || []
      if (!urls.length) throw new Error('Completed but no result URLs')
      return urls
    }
    if (state === 'failed') throw new Error(`Generation failed: ${polled?.data?.failMsg || polled?.data?.failCode || 'unknown'}`)
  }
  throw new Error(`Timed out after ${Math.round(TIMEOUT_MS / 1000)}s (task ${taskId} still running)`)
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const type = a.type
  let urls
  if (type === 'image') {
    if (!a.prompt) throw new Error('--prompt is required for --type image')
    urls = await runAsyncTask('images', {
      model: a.model || 'gpt-image-2', prompt: a.prompt,
      ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
      ...(a.resolution ? { resolution: a.resolution } : {}),
      ...(a.image_url ? { image_url: a.image_url } : {}),
    })
  } else if (type === 'video') {
    if (!a.prompt) throw new Error('--prompt is required for --type video')
    urls = await runAsyncTask('video', {
      model: a.model || 'seedance-2.0-fast', prompt: a.prompt,
      ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
      ...(a.resolution ? { resolution: a.resolution } : {}),
      ...(a.duration ? { duration: a.duration } : {}),
      ...(a.image_url ? { images: [a.image_url] } : {}),
    })
  } else if (type === 'tts') {
    if (!a.text) throw new Error('--text is required for --type tts')
    urls = await runAsyncTask('audio', {
      model: a.model || 'minimax-speech-02-turbo', text: a.text,
      voice_id: a.voice_id || 'English_Trustworthy_Man',
    })
  } else {
    throw new Error('--type must be one of: image, video, tts')
  }
  console.log(urls.join('\n'))
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1) })

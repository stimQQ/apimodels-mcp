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
 *
 * Waiting (0.3.0): the script waits at most --wait seconds (default 50). If the task is
 * still running it prints `TASK_ID=<id> STATE=running` and exits 2; resume with
 *   node generate.mjs --task_id <id> [--wait 120]
 * Why: this script runs inside an agent's shell tool, and Claude Code's Bash tool kills a
 * command after 2 minutes by default while video takes a median 2.5 min (p90 8 min). The
 * old "poll for up to 5 minutes" lost the URL of a task that then completed and was billed.
 */

const BASE_URL = (process.env.APIMODELS_BASE_URL || 'https://api.apimodels.app/v1').replace(/\/$/, '')
const API_KEY = process.env.APIMODELS_API_KEY
const DEFAULT_WAIT_S = Number(process.env.APIMODELS_WAIT_SECONDS)
  || Math.round((Number(process.env.APIMODELS_TIMEOUT_MS) || 0) / 1000) || 50

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

async function submitTask(kind, body) {
  const created = await apiFetch(`/${kind}/generations`, { method: 'POST', body: JSON.stringify(body) })
  const taskId = created?.data?.taskId
  if (!taskId) throw new Error(`No taskId returned: ${JSON.stringify(created)}`)
  return taskId
}

/**
 * Wait up to waitS seconds for the task. Task lookup is by id alone on the server, so any
 * of the three endpoints answers for any task — `kind` only picks the path.
 * Returns the URL list when done; prints the resume line and exits 2 if still running.
 */
async function waitForTask(kind, taskId, waitS) {
  const deadline = Date.now() + waitS * 1000
  for (;;) {
    const polled = await apiFetch(`/${kind}/generations?task_id=${encodeURIComponent(taskId)}`)
    const d = polled?.data || {}
    if (d.state === 'completed') {
      const urls = d.resultUrls || []
      if (!urls.length) throw new Error(`Task ${taskId} completed but no result URLs`)
      return urls
    }
    if (d.state === 'failed') throw new Error(`Generation failed (task ${taskId}, not billed): ${d.failMsg || d.failCode || 'unknown'}`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      console.log(`TASK_ID=${taskId} STATE=running`)
      console.error(`Still running after ${waitS}s. Resume with: node generate.mjs --task_id ${taskId} --wait 120  (do not resubmit; it is billed once, on completion)`)
      process.exit(2)
    }
    await sleep(Math.min(3000, remaining))
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const type = a.type
  const waitS = a.wait != null ? Number(a.wait) : DEFAULT_WAIT_S
  if (!Number.isFinite(waitS) || waitS < 0) throw new Error('--wait must be a number of seconds')
  if (a.task_id) {
    console.log((await waitForTask('video', String(a.task_id).trim(), waitS)).join('\n'))
    return
  }
  let urls

/**
 * 把调用方给的东西变成我们服务器取得到的 URL。
 *
 * 起因:agent 经常直接给本地路径,或者给一个 `http://127.0.0.1:8000/x.png`。
 * 我们的生成服务器两个都够不着——那里的 127.0.0.1 指的是**我们的机器**,不是用户的——
 * 任务会以一句上游黑话「private/reserved IP addresses not allowed」失败。
 * 服务端没法修:文件只存在于用户机器上。但这个脚本就跑在那台机器上,所以它能读到文件、
 * 或者取到那个 localhost URL,再上传到 /v1/files 换一个公网 URL。
 * 公网 http(s) 原样放行。
 */
async function resolveImageInput(input) {
  const raw = String(input).trim()
  if (raw.startsWith('data:')) {
    const m = raw.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
    if (!m) throw new Error('Malformed data: URI')
    const buf = Buffer.from(m[2] ? m[3] : decodeURIComponent(m[3]), m[2] ? 'base64' : 'utf8')
    return uploadBytes(buf, 'input.png', m[1])
  }
  if (/^https?:\/\//i.test(raw)) {
    const h = new URL(raw).hostname
    const local = h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) ||
      /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local')
    if (!local) return raw
    const r = await fetch(raw)
    if (!r.ok) throw new Error(`Could not read ${raw} from this machine (HTTP ${r.status})`)
    const name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'input.png')
    return uploadBytes(Buffer.from(await r.arrayBuffer()), name, r.headers.get('content-type') || 'image/png')
  }
  const { readFile } = await import('node:fs/promises')
  const { basename } = await import('node:path')
  const { homedir } = await import('node:os')
  const path = raw.startsWith('~') ? homedir() + raw.slice(1) : raw
  let buf
  try { buf = await readFile(path) }
  catch { throw new Error(`Not a URL, and no readable file at "${raw}". Pass a public https:// URL, a local file path, or a data: URI.`) }
  const ext = (basename(path).split('.').pop() || '').toLowerCase()
  const mime = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' }[ext] || 'image/png'
  return uploadBytes(buf, basename(path), mime)
}

async function uploadBytes(buf, filename, contentType) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)], { type: contentType }), filename)
  const r = await fetch(`${BASE_URL}/files`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}` }, body: form })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j?.data?.publicUrl) throw new Error(`Upload of ${filename} failed: ${j?.msg || 'HTTP ' + r.status}`)
  return j.data.publicUrl
}

  if (type === 'image') {
    if (!a.prompt) throw new Error('--prompt is required for --type image')
    const id = await submitTask('images', {
      model: a.model || 'gpt-image-2', prompt: a.prompt,
      ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
      ...(a.resolution ? { resolution: a.resolution } : {}),
      ...(a.image_url ? { image_url: await resolveImageInput(a.image_url) } : {}),
    })
    urls = await waitForTask('images', id, waitS)
  } else if (type === 'video') {
    if (!a.prompt) throw new Error('--prompt is required for --type video')
    const id = await submitTask('video', {
      model: a.model || 'seedance-2.0-fast', prompt: a.prompt,
      ...(a.aspect_ratio ? { aspect_ratio: a.aspect_ratio } : {}),
      ...(a.resolution ? { resolution: a.resolution } : {}),
      ...(a.duration ? { duration: a.duration } : {}),
      ...(a.image_url ? { images: [await resolveImageInput(a.image_url)] } : {}),
    })
    urls = await waitForTask('video', id, waitS)
  } else if (type === 'tts') {
    if (!a.text) throw new Error('--text is required for --type tts')
    const id = await submitTask('audio', {
      model: a.model || 'minimax-speech-02-turbo', text: a.text,
      voice_id: a.voice_id || 'English_Trustworthy_Man',
    })
    urls = await waitForTask('audio', id, waitS)
  } else {
    throw new Error('--type must be one of: image, video, tts (or --task_id <id> to resume)')
  }
  console.log(urls.join('\n'))
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1) })

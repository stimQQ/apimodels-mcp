/**
 * Offline self-test for the MCP tools: every tool is called through a real MCP client over an in-memory
 * transport, against a mocked fetch that records each request to the apimodels API. No network, no cost.
 * Checks that each tool sends the field names the backend actually reads (verified against apimodels-backend
 * src/api/*.ts on 2026-11-08) — the class of bug where a parameter is accepted by the tool and silently
 * ignored by the API.
 *
 *   pnpm build && pnpm test
 */
process.env.APIMODELS_MCP_NO_MAIN = '1'
process.env.APIMODELS_API_KEY = 'sk_selftest'
process.env.APIMODELS_BASE_URL = 'https://api.test/v1'

import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

let bad = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  <- ' + detail}`); if (!cond) bad++ }

// ── mocked API ─────────────────────────────────────────────────────
const calls = []
let assetGroups = []
let syncImageAnswer = false // simulate an API without the async flag: WxH size → OpenAI synchronous answer
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  const method = (init.method || 'GET').toUpperCase()
  let body = init.body
  let files
  if (body instanceof FormData) {
    const f = body.get('file')
    files = { name: f.name, type: f.type, size: f.size }
    body = undefined
  } else if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { /* keep string */ }
  }
  calls.push({ url, method, body, files })
  const path = url.replace('https://api.test/v1', '')
  if (method === 'POST' && path === '/images/generations' && syncImageAnswer) return jsonRes({ created: 1, data: [{ url: 'https://r2.test/images/sync.gif' }] })
  if (method === 'POST' && /^\/(images|video|audio)\/generations$/.test(path)) return jsonRes({ code: 200, data: { taskId: 'task_1' } })
  if (method === 'GET' && /\/generations\?task_id=/.test(path)) {
    const kind = path.split('/')[1]
    return jsonRes({ code: 200, data: { state: 'completed', resultUrls: [`https://r2.test/${kind}/out.bin`], modelType: kind === 'images' ? 'TEXT_TO_IMAGE' : kind === 'video' ? 'TEXT_TO_VIDEO' : 'TEXT_TO_SPEECH' } })
  }
  if (path === '/files') return jsonRes({ code: 200, data: { publicUrl: `https://r2.test/uploads/${files.name}` } })
  if (path === '/tts/stream') return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  if (path.startsWith('/voices/catalog')) return jsonRes({ code: 200, data: { voices: [{ id: 'v1', name: 'Warm' }], total: 1 } })
  if (path === '/embeddings') return jsonRes({ object: 'list', model: body.model, data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3 } })
  if (path.startsWith('/media/')) return jsonRes({ code: 200, data: { endpoint: path, title: 't' } })
  if (path === '/systemone') return jsonRes({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.3 } } })
  if (path === '/audio/lyrics') return jsonRes({ code: 200, data: { lyric: '[Verse]\nla la', title: 'Road', tags: 'pop' } })
  if (path === '/assets/groups' && method === 'GET') return jsonRes({ code: 'success', data: assetGroups })
  if (path === '/assets/groups' && method === 'POST') { assetGroups = [{ id: 7, name: body.name }]; return jsonRes({ code: 'success', data: { id: 7, name: body.name } }) }
  if (path === '/assets') return jsonRes({ code: 'success', data: { id: 'asset-1', asset_url: 'asset://asset-1', status: 'Active' } })
  if (path === '/assets/list') return jsonRes({ code: 'success', data: { items: [], total: 0 } })
  if (path === '/assets/get') return jsonRes({ code: 'success', data: { id: body.id, status: 'Active' } })
  if (path === '/assets/delete') return jsonRes({ code: 'success', data: { id: body.id } })
  if (path === '/balance') return jsonRes({ code: 200, data: { balance: 1, total: 1, frozen: 0 } })
  return jsonRes({ msg: `unmocked ${method} ${path}` }, 404)
}

const { buildServer } = await import('../dist/index.js')
const [clientT, serverT] = InMemoryTransport.createLinkedPair()
await buildServer().connect(serverT)
const client = new Client({ name: 'selftest', version: '1' })
await client.connect(clientT)

const dir = mkdtempSync(join(tmpdir(), 'mcp-selftest-'))
const localPng = join(dir, 'face.png'); writeFileSync(localPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const localMp4 = join(dir, 'clip.mp4'); writeFileSync(localMp4, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))
const localMp3 = join(dir, 'voice.mp3'); writeFileSync(localMp3, Buffer.from([0x49, 0x44, 0x33]))

/** Call a tool; return { text, isError, req } where req = the POST to the given API path (last one). */
async function call(name, args, apiPath) {
  calls.length = 0
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const req = apiPath ? [...calls].reverse().find((c) => c.url.endsWith(apiPath) && c.method === 'POST') : undefined
  return { text, isError: !!r.isError, req, calls: [...calls] }
}

console.log('\n— tool list —')
const tools = (await client.listTools()).tools.map((t) => t.name).sort()
const expected = ['chat', 'delete_asset', 'embed', 'extract_media', 'generate_audio', 'generate_image', 'generate_video', 'get_asset', 'get_balance', 'get_task', 'jev_decide', 'list_assets', 'list_models', 'list_voices', 'review_image', 'text_to_speech', 'upload_asset', 'write_lyrics']
ok(`18 local tools (get_upload_url is hosted-only)`, JSON.stringify(tools) === JSON.stringify(expected), JSON.stringify(tools))
const annotations = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations || {}]))
ok('read-only: list_voices, list_assets, get_asset (no approval prompt in Codex)', ['list_voices', 'list_assets', 'get_asset'].every((n) => annotations[n].readOnlyHint === true))
ok('delete_asset is marked destructive', annotations.delete_asset.destructiveHint === true && annotations.delete_asset.readOnlyHint === false)

console.log('\n— generate_image —')
let r = await call('generate_image', {
  model: 'gpt-image-2.6-flare', prompt: 'a waving capybara sticker', output_format: 'gif', frame_count: 8, frame_duration_ms: 120,
  size: '512x512', image_urls: [localPng, 'https://cdn.test/b.png', 'asset://asset-9'], mask_url: 'https://cdn.test/m.png',
  markup_image_url: 'https://cdn.test/k.png', n: 2, quality: 'low', reasoning_effort: 'high', background: 'opaque',
  extra: { seed: 42, model: 'hijack', prompt: 'hijack' }, return_image: false,
}, '/images/generations')
let b = r.req?.body ?? {}
ok('gif fields sent as the API names them', b.output_format === 'gif' && b.frame_count === 8 && b.frame_duration_ms === 120 && b.size === '512x512', JSON.stringify(b))
ok('image_urls: local file uploaded, URL and asset:// passed through', JSON.stringify(b.image_urls) === JSON.stringify(['https://r2.test/uploads/face.png', 'https://cdn.test/b.png', 'asset://asset-9']), JSON.stringify(b.image_urls))
ok('mask_url / markup_image_url / n / quality / reasoning_effort / background', b.mask_url === 'https://cdn.test/m.png' && b.markup_image_url === 'https://cdn.test/k.png' && b.n === 2 && b.quality === 'low' && b.reasoning_effort === 'high' && b.background === 'opaque', JSON.stringify(b))
ok('extra passes through, but cannot override model / prompt', b.seed === 42 && b.model === 'gpt-image-2.6-flare' && b.prompt === 'a waving capybara sticker', JSON.stringify(b))
ok('result URL returned', /r2\.test\/images\/out\.bin/.test(r.text), r.text)
ok('image requests carry async:true + response_format url (no synchronous mode with an exact size)', b.async === true && b.response_format === 'url', JSON.stringify(b))
syncImageAnswer = true
r = await call('generate_image', { model: 'gpt-image-2.6-flare', prompt: 'x', size: '512x512', output_format: 'gif', return_image: false }, '/images/generations')
ok('an API that still answers synchronously → URL returned as done, not "No taskId"', !r.isError && /r2\.test\/images\/sync\.gif/.test(r.text) && !r.calls.some((c) => c.url.includes('task_id=')), r.text)
syncImageAnswer = false
r = await call('generate_video', { model: 'seedance-2.0-fast', prompt: 'p' }, '/video/generations')
ok('video / audio requests do not carry the image-only async flag', r.req?.body.async === undefined && r.req?.body.response_format === undefined, JSON.stringify(r.req?.body))
r = await call('generate_image', { model: 'gpt-image-2.6-flare', prompt: 'x', frame_count: 4, return_image: false })
ok('frame_count without output_format gif is refused before any API call', r.isError && /only apply with output_format "gif"/.test(r.text) && r.calls.length === 0, r.text)
r = await call('generate_image', { model: 'doubao-seedream-5-0-flash', prompt: 'x', background: 'transparent', return_image: false })
ok('seedream + transparent without an input image is refused', r.isError && /needs image_url/.test(r.text), r.text)
r = await call('generate_image', { model: 'gpt-image-2.6-flare', prompt: 'logo', background: 'transparent', return_image: false }, '/images/generations')
ok('gpt-image + transparent works without an input image', !r.isError && r.req?.body.background === 'transparent', r.text)

console.log('\n— generate_video —')
r = await call('generate_video', { model: 'seedance-2.0-fast', prompt: 'p', image_url: localPng, last_frame_url: 'https://cdn.test/end.png', reference_image_urls: ['asset://asset-1'], reference_video_urls: [localMp4], reference_audio_urls: [localMp3], generate_audio: false, seed: 7, negative_prompt: 'blur' }, '/video/generations')
b = r.req?.body ?? {}
ok('seedance: first frame as images[0] (unchanged since 0.3)', JSON.stringify(b.images) === JSON.stringify(['https://r2.test/uploads/face.png']) && b.image === undefined, JSON.stringify(b))
ok('last frame sent as last_frame_url and image_tail', b.last_frame_url === 'https://cdn.test/end.png' && b.image_tail === 'https://cdn.test/end.png', JSON.stringify(b))
ok('reference lists resolved (asset:// kept, local mp4 / mp3 uploaded)', b.reference_image_urls?.[0] === 'asset://asset-1' && b.reference_video_urls?.[0] === 'https://r2.test/uploads/clip.mp4' && b.reference_audio_urls?.[0] === 'https://r2.test/uploads/voice.mp3', JSON.stringify(b))
const up = r.calls.filter((c) => c.url.endsWith('/files')).map((c) => c.files.type).sort()
ok('uploads carry the right content type (image/png, video/mp4, audio/mpeg)', JSON.stringify(up) === JSON.stringify(['audio/mpeg', 'image/png', 'video/mp4']), JSON.stringify(up))
ok('generate_audio false / seed / negative_prompt', b.generate_audio === false && b.seed === 7 && b.negative_prompt === 'blur', JSON.stringify(b))
r = await call('generate_video', { model: 'kling-v2-6', prompt: 'p', image_url: 'https://cdn.test/a.png' }, '/video/generations')
ok('kling-v2-6: first frame as scalar image (images[] is ignored by that route)', r.req?.body.image === 'https://cdn.test/a.png' && r.req?.body.images === undefined, JSON.stringify(r.req?.body))
for (const m of ['dreamactor-v2', 'v3.1-fast-start-end', 'wan-animate', 'kling-v3-omni']) {
  r = await call('generate_video', { model: m, prompt: 'p', image_url: 'https://cdn.test/a.png' }, '/video/generations')
  ok(`${m}: first frame as image`, r.req?.body.image === 'https://cdn.test/a.png' && !r.req?.body.images, JSON.stringify(r.req?.body))
}
r = await call('generate_video', { model: 'kling-v3-motion-control', image_url: 'https://cdn.test/a.png', video_url: 'https://cdn.test/d.mp4' }, '/video/generations')
ok('motion control: input_urls + video_urls (the route requires both)', JSON.stringify(r.req?.body.input_urls) === '["https://cdn.test/a.png"]' && JSON.stringify(r.req?.body.video_urls) === '["https://cdn.test/d.mp4"]' && !r.req?.body.video_url && !r.req?.body.prompt, JSON.stringify(r.req?.body))
r = await call('generate_video', { model: 'kling-lip-sync-video', audio_url: 'https://cdn.test/a.mp3', extra: { sessionId: 's', faceId: 'f' } }, '/video/generations')
ok('kling-lip-sync-video: audio also as camelCase audioUrl; extra sessionId / faceId pass through', r.req?.body.audioUrl === 'https://cdn.test/a.mp3' && r.req?.body.sessionId === 's' && r.req?.body.faceId === 'f', JSON.stringify(r.req?.body))
r = await call('generate_video', { model: 'digital-human', video_url: localMp4, audio_url: 'https://cdn.test/a.mp3' }, '/video/generations')
ok('digital-human: video_url (local mp4 uploaded) + audio_url, no prompt needed', r.req?.body.video_url === 'https://r2.test/uploads/clip.mp4' && r.req?.body.audio_url === 'https://cdn.test/a.mp3' && !r.isError, JSON.stringify(r.req?.body))

console.log('\n— text_to_speech —')
r = await call('text_to_speech', { text: 'hi' }, '/audio/generations')
ok('minimax default: voice_id filled in', r.req?.body.model === 'minimax-speech-02-turbo' && r.req?.body.voice_id === 'English_Trustworthy_Man', JSON.stringify(r.req?.body))
r = await call('text_to_speech', { text: 'hi', model: 'minimax-speech-2.8-hd', voice_id: 'female-tianmei', speed: 1.2 }, '/audio/generations')
ok('minimax speed goes in voice_setting', r.req?.body.voice_setting?.speed === 1.2 && r.req?.body.voice_setting?.voice_id === 'female-tianmei', JSON.stringify(r.req?.body))
r = await call('text_to_speech', { text: 'hi', model: 'fish-s2.1-pro', voice_id: 'fish-voice-1' }, '/audio/generations')
ok('fish: voice sent as reference_id, not voice_id', r.req?.body.reference_id === 'fish-voice-1' && r.req?.body.voice_id === undefined, JSON.stringify(r.req?.body))
r = await call('text_to_speech', { text: 'hi', model: 'kling-tts' })
ok('kling-tts without voice_id is refused before any API call', r.isError && r.calls.length === 0, r.text)
const savePath = join(dir, 'line.mp3')
r = await call('text_to_speech', { text: 'hello', model: 'eleven-tts-v3', voice_id: 'EXAV', speed: 0.9, language_code: 'en', save_to: savePath }, '/tts/stream')
ok('eleven: /tts/stream with voice_settings.speed and language_code', r.req?.body.model === 'eleven-tts-v3' && r.req?.body.voice_id === 'EXAV' && r.req?.body.voice_settings?.speed === 0.9 && r.req?.body.language_code === 'en', JSON.stringify(r.req?.body))
const ttsUp = r.calls.find((c) => c.url.endsWith('/files'))
ok('eleven: audio bytes uploaded as audio/mpeg and the URL returned', ttsUp?.files.type === 'audio/mpeg' && /r2\.test\/uploads\/speech\.mp3/.test(r.text), r.text)
ok('eleven: save_to writes the file locally', existsSync(savePath) && readFileSync(savePath).length === 6)
ok('eleven: never touches /audio/generations (it rejects eleven-tts-*)', !r.calls.some((c) => c.url.includes('/audio/generations')))

console.log('\n— list_voices / generate_audio / write_lyrics —')
r = await call('list_voices', { provider: 'fish', language: 'zh', q: 'warm' })
ok('list_voices query string', r.calls[0]?.url === 'https://api.test/v1/voices/catalog?provider=fish&language=zh&q=warm&page_size=20', r.calls[0]?.url)
r = await call('generate_audio', { model: 'suno-v5', prompt: 'a road-trip song', instrumental: false }, '/audio/generations')
ok('suno, no lyrics: prompt sent as description (Suno ignores prompt)', r.req?.body.description === 'a road-trip song' && r.req?.body.prompt === undefined && r.req?.body.instrumental === false, JSON.stringify(r.req?.body))
r = await call('generate_audio', { model: 'suno-v5', prompt: 'lo-fi, mellow', lyrics: '[Verse] la', title: 'Road' }, '/audio/generations')
ok('suno with lyrics: lyrics + prompt as style tags', r.req?.body.lyrics === '[Verse] la' && r.req?.body.tags === 'lo-fi, mellow' && r.req?.body.title === 'Road' && !r.req?.body.description && !r.req?.body.prompt, JSON.stringify(r.req?.body))
r = await call('generate_audio', { model: 'eleven-sfx-v3', prompt: 'glass breaking', duration_seconds: 2 }, '/audio/generations')
ok('sound effects: prompt + duration_seconds', r.req?.body.prompt === 'glass breaking' && r.req?.body.duration_seconds === 2, JSON.stringify(r.req?.body))
r = await call('generate_audio', { model: 'eleven-isolator', audio_url: localMp3 }, '/audio/generations')
ok('isolator: local audio uploaded as audio_url', r.req?.body.audio_url === 'https://r2.test/uploads/voice.mp3', JSON.stringify(r.req?.body))
r = await call('generate_audio', { model: 'eleven-dubbing', source_url: 'https://cdn.test/v.mp4', target_lang: 'es', extra: { num_speakers: 2 } }, '/audio/generations')
ok('dubbing: source_url + target_lang + extra', r.req?.body.source_url === 'https://cdn.test/v.mp4' && r.req?.body.target_lang === 'es' && r.req?.body.num_speakers === 2, JSON.stringify(r.req?.body))
r = await call('generate_audio', { model: 'eleven-dialogue', inputs: [{ text: 'Hi', voice_id: 'a' }, { text: 'Hey', voice_id: 'b' }] }, '/audio/generations')
ok('dialogue: inputs array', r.req?.body.inputs?.length === 2, JSON.stringify(r.req?.body))
r = await call('write_lyrics', { prompt: 'summer' }, '/audio/lyrics')
ok('write_lyrics → /audio/lyrics, title / tags / lyric in the answer', r.req?.body.prompt === 'summer' && /TITLE: Road/.test(r.text) && /la la/.test(r.text), r.text)

console.log('\n— embed / extract_media / jev_decide —')
r = await call('embed', { input: ['a', 'b'], model: 'text-embedding-3-large', dimensions: 256 }, '/embeddings')
ok('embed body + vectors returned', r.req?.body.model === 'text-embedding-3-large' && r.req?.body.dimensions === 256 && /"embeddings"/.test(r.text), r.text)
r = await call('extract_media', { url: 'https://youtube.com/@x', op: 'playlist', cursor: 'c2' }, '/media/playlist')
ok('extract_media playlist → /media/playlist with cursor', r.req?.body.url === 'https://youtube.com/@x' && r.req?.body.cursor === 'c2', JSON.stringify(r.req?.body))
r = await call('extract_media', { url: 'https://youtu.be/x', op: 'youtube_download' }, '/media/youtube-download')
ok('extract_media youtube_download → /media/youtube-download', !!r.req && r.req.body.cursor === undefined)
r = await call('jev_decide', { state: 'charged twice', questions: { urgent: { type: 'noul', instructions: 'needs a reply within the hour' } } }, '/systemone')
ok('jev_decide → /systemone with model jev', r.req?.body.model === 'jev' && r.req?.body.questions.urgent.type === 'noul', JSON.stringify(r.req?.body))

console.log('\n— assets —')
assetGroups = []
r = await call('upload_asset', { source: localMp4, name: 'hero' }, '/assets')
ok('no "mcp" group yet → created, then used', r.calls.some((c) => c.url.endsWith('/assets/groups') && c.method === 'POST' && c.body.name === 'mcp') && r.req?.body.group_id === 7, JSON.stringify(r.calls.map((c) => c.method + ' ' + c.url)))
ok('local mp4 uploaded, asset_type Video detected, name kept', r.req?.body.url === 'https://r2.test/uploads/clip.mp4' && r.req?.body.asset_type === 'Video' && r.req?.body.name === 'hero', JSON.stringify(r.req?.body))
ok('answer leads with the asset:// reference', r.text.startsWith('asset://asset-1'), r.text)
r = await call('upload_asset', { source: 'https://cdn.test/p.jpg' }, '/assets')
ok('existing "mcp" group reused (no second create)', !r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/assets/groups')) && r.req?.body.group_id === 7 && r.req?.body.asset_type === 'Image')
r = await call('upload_asset', { source: 'https://cdn.test/noext', group_id: 3 })
ok('unknown type without asset_type is refused before uploading', r.isError && /asset_type/.test(r.text) && !r.calls.some((c) => c.url.endsWith('/assets')), r.text)
r = await call('list_assets', { name: 'hero' }, '/assets/list')
ok('list_assets → groups + /assets/list', r.req?.body.name === 'hero' && r.req?.body.page_number === 1 && r.calls.some((c) => c.method === 'GET' && c.url.endsWith('/assets/groups')))
r = await call('get_asset', { id: 'asset-1' }, '/assets/get')
ok('get_asset', r.req?.body.id === 'asset-1')
r = await call('delete_asset', { id: 'asset-1' }, '/assets/delete')
ok('delete_asset', r.req?.body.id === 'asset-1' && /Deleted asset asset-1/.test(r.text), r.text)

console.log(bad ? `\n${bad} FAILED` : '\nall passed')
process.exit(bad ? 1 : 0)

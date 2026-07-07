#!/usr/bin/env node
/**
 * coverbean-skill — generate platform-ready cover / thumbnail images via
 * apimodels.app (gpt-image-2-all). Submits the job, polls, downloads the image,
 * and crops it to the exact size each platform expects.
 *
 * Usage:
 *   APIMODELS_API_KEY=... node cover.mjs --platform youtube \
 *     --prompt 'bold YouTube thumbnail, shocked man pointing at a glowing AI chip, ...' \
 *     --out ./covers
 *
 *   --platform  xiaohongshu | wechat | douyin | tiktok | youtube | all   (required)
 *   --prompt    the full image description, WITH the title text baked in    (required)
 *   --out       output directory (default: current dir)
 *   --model     image model (default: gpt-image-2-all)
 *   --quality   low | medium | high | auto   (default: low)
 *   --resolution 1K | 2K | 4K   (default: 1K)
 *
 * The host agent (Claude, etc.) is the LLM here: it writes the title + prompt.
 * This script only renders + sizes. See SKILL.md for the prompt recipe.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const BASE = process.env.APIMODELS_BASE_URL || 'https://apimodels.app'
const KEY = process.env.APIMODELS_API_KEY
if (!KEY) {
  console.error(`APIMODELS_API_KEY is not set. To get one (~1 min):
  1. Sign up at https://apimodels.app and add a little credit (a cover is $0.005 — $1 is ~200 covers)
  2. Create a key at https://apimodels.app/console/api-keys
  3. export APIMODELS_API_KEY=sk-...   then re-run this command.`)
  process.exit(1)
}

// platform -> { generation aspect ratio (snaps to the model's nearest bucket),
//               exact output pixels the platform expects, human label }
const PLATFORMS = {
  xiaohongshu: { aspect: '3:4',    w: 1080, h: 1440, label: '小红书 3:4' },
  wechat:      { aspect: '2.35:1', w: 1080, h: 459,  label: '微信公众号头图 2.35:1' },
  douyin:      { aspect: '9:16',   w: 1080, h: 1920, label: '抖音 9:16' },
  tiktok:      { aspect: '9:16',   w: 1080, h: 1920, label: 'TikTok 9:16' },
  youtube:     { aspect: '16:9',   w: 1280, h: 720,  label: 'YouTube 16:9' },
}

function parseArgs() {
  const a = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++ }
  }
  return a
}

async function generateOne(platform, spec, prompt, model, quality, resolution, outDir) {
  // 1. create
  const createRes = await fetch(`${BASE}/api/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, aspect_ratio: spec.aspect, resolution, quality }),
  })
  const created = await createRes.json()
  if (created.code !== 200 || !created.data?.taskId) {
    throw new Error(`[${platform}] create failed: ${created.msg || JSON.stringify(created).slice(0, 200)}`)
  }
  const taskId = created.data.taskId

  // 2. poll
  let url = ''
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const r = await fetch(`${BASE}/api/v1/images/generations?task_id=${taskId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    })
    const d = (await r.json()).data || {}
    const state = d.state || d.status
    if (state === 'completed') { url = (d.resultUrls || [])[0]; break }
    if (state === 'failed') throw new Error(`[${platform}] generation failed: ${d.failMsg || d.error || 'unknown'}`)
  }
  if (!url) throw new Error(`[${platform}] timed out waiting for the image`)

  // 3. download
  const raw = Buffer.from(await (await fetch(url)).arrayBuffer())
  mkdirSync(outDir, { recursive: true })
  const rawPath = join(outDir, `${platform}-cover-raw.png`)
  writeFileSync(rawPath, raw)

  // 4. crop + scale to the platform's exact size (cover-fit, center). ffmpeg is
  //    ubiquitous for creators; if absent, keep the raw image + print the command.
  const outPath = join(outDir, `${platform}-cover.png`)
  const ff = spawnSync('ffmpeg', [
    '-y', '-i', rawPath,
    '-vf', `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=increase,crop=${spec.w}:${spec.h}`,
    outPath,
  ], { stdio: 'ignore' })
  if (ff.status === 0 && existsSync(outPath)) {
    return { path: outPath, url, exact: true }
  }
  return { path: rawPath, url, exact: false, w: spec.w, h: spec.h }
}

const args = parseArgs()
const prompt = args.prompt
const model = args.model || 'gpt-image-2-all'
const quality = args.quality || 'low'
const resolution = args.resolution || '1K'
const outDir = args.out || process.cwd()
if (!prompt) { console.error('ERROR: --prompt is required (the image description with the title text baked in)'); process.exit(1) }

const targets = args.platform === 'all'
  ? Object.keys(PLATFORMS)
  : [args.platform]
if (!targets[0] || targets.some(p => !PLATFORMS[p])) {
  console.error(`ERROR: --platform must be one of: ${Object.keys(PLATFORMS).join(', ')}, all`)
  process.exit(1)
}

for (const p of targets) {
  try {
    const r = await generateOne(p, PLATFORMS[p], prompt, model, quality, resolution, outDir)
    if (r.exact) {
      console.log(`✓ ${PLATFORMS[p].label} → ${r.path}`)
    } else {
      console.log(`✓ ${PLATFORMS[p].label} → ${r.path} (raw; ffmpeg not found — crop to ${r.w}x${r.h} yourself, e.g. an online resizer)`)
    }
  } catch (e) {
    console.error(`✗ ${e.message}`)
  }
}

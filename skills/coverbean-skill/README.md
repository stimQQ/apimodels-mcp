# Coverbean

**Generate ready-to-post cover / thumbnail images for 小红书 · 微信公众号 · 抖音 · TikTok · YouTube — from inside your AI agent.**

Coverbean is a [Claude Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview). You describe the post; your agent writes the title and the image prompt; Coverbean renders it and crops it to the exact size each platform expects. Powered by [apimodels.app](https://apimodels.app)'s `gpt-image-2-all`.

- **Five platforms, exact sizes** — 3:4, 2.35:1, 9:16, 16:9, cropped precisely (via ffmpeg).
- **Great text-in-image** — short titles render crisp and legible.
- **Cheap** — a 1K cover is **$0.005**; the **$1 free credit** on signup is ~**200 covers**.
- **No lock-in on thinking** — the agent (Claude, etc.) does the copywriting for free; you only pay for the render.

| Platform | Output size |
| --- | --- |
| 小红书 (`xiaohongshu`) | 1080 × 1440 (3:4) |
| 微信公众号 (`wechat`) | 1080 × 459 (2.35:1) |
| 抖音 (`douyin`) | 1080 × 1920 (9:16) |
| TikTok (`tiktok`) | 1080 × 1920 (9:16) |
| YouTube (`youtube`) | 1280 × 720 (16:9) |
| all five (`all`) | — |

## Setup (about a minute)

1. **Sign up** at <https://apimodels.app> — new accounts get **$1 free** (~200 covers).
2. **Create an API key** at <https://apimodels.app/console/api-keys>.
3. **Export it:**
   ```bash
   export APIMODELS_API_KEY=sk-xxxxxxxx
   ```

Also needs **Node.js 18+**, and optionally **ffmpeg** (for exact cropping).

## Install

**Claude Code** — drop the folder into your skills directory:

```bash
git clone https://github.com/<your-org>/coverbean-skill ~/.claude/skills/coverbean-skill
```

Then just ask Claude: *"Make me a YouTube thumbnail about 'AI is coming for your job'."*

**Any agent / manual** — run the bundled script directly:

```bash
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/cover.mjs \
  --platform youtube \
  --prompt 'Bold thumbnail: wide-eyed creator pointing at a glowing AI chip, dramatic lighting, saturated teal/orange, large bold headline "AI 抢工作?" across the top third, high contrast' \
  --out ./covers
```

Use `--platform all` to render all five at once. Defaults: `gpt-image-2-all`, `--quality low`, `--resolution 1K`.

## How it works

```
你: 给这篇文章做个 YouTube 封面
  └─ 你的 Agent(Claude)  →  起标题 + 写图像提示词   (免费,不花你钱)
       └─ Coverbean (cover.mjs)  →  gpt-image-2-all 出图 → 下载 → ffmpeg 精裁到平台尺寸
            └─ ./covers/youtube-cover.png  (1280×720, ready to upload)
```

The prompt recipe (short quoted title, one bold subject, high contrast, per-platform vibe) lives in [`SKILL.md`](./SKILL.md) so the agent writes covers that actually convert.

## Notes

- Generated files on apimodels.app expire after **7 days** — the script downloads them locally right away.
- Estimate cost at <https://apimodels.app/tools>; browse all models at <https://apimodels.app/models>.

---

Powered by [apimodels.app](https://apimodels.app) — one key, many models (image · video · LLM · audio).

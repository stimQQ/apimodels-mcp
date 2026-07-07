---
name: coverbean-skill
description: Generate ready-to-post cover / thumbnail images for Xiaohongshu (小红书), WeChat Official Account (微信公众号), Douyin (抖音), TikTok, and YouTube. Use when the user wants a cover, thumbnail, or 封面 for a post, article, or video — you (the agent) write the title and image prompt, this skill renders it at the exact size each platform expects. Powered by apimodels.app; needs an apimodels.app API key.
---

# coverbean-skill

Turn a topic (or an exact title) into a **platform-ready cover image** — sized correctly for 小红书 / 微信公众号 / 抖音 / TikTok / YouTube — using [apimodels.app](https://apimodels.app)'s `gpt-image-2-all` image model.

**You are the brain here.** You (the host agent) analyze the content, write a punchy title, and compose the image prompt. This skill only renders the image and crops it to the right size — so it costs the user nothing for the thinking, only for the image render.

## First-time setup (walk the user through this if `APIMODELS_API_KEY` is missing)

Coverbean renders through [apimodels.app](https://apimodels.app). The user needs an account with a little credit + an API key. It takes about a minute:

1. **Sign up** at <https://apimodels.app>.
2. **Add a little credit** — covers are cheap: a 1K cover is **$0.005**, so **$1 ≈ 200 covers**.
3. **Create an API key** at <https://apimodels.app/console/api-keys> and copy it (it starts with `sk-`).
4. **Export it** in the shell that will run the skill:
   ```bash
   export APIMODELS_API_KEY=sk-xxxxxxxx
   ```

Then you're ready. Also needed: **Node.js 18+** (the script uses built-in `fetch`) and, optionally, **`ffmpeg`** on PATH for exact per-platform cropping (without it the raw image is still saved).

> If the user hasn't set `APIMODELS_API_KEY`, don't guess — walk them through the three steps above first, then continue.

## Workflow

1. **Get the inputs.** The user gives you a topic/content and a platform (or "all"). If they gave an exact title, use it verbatim; otherwise write a short, punchy title yourself.
2. **Write one image prompt** following the recipe below (embed the title text in it).
3. **Run the script** once per platform (or `--platform all`).
4. **Show the user the saved file path(s)** and offer tweaks.

## Cover prompt recipe (write the prompt for the model)

A cover lives or dies on **one bold subject + a few big words**. Build the prompt like this:

- **State the exact title text in quotes, and keep it short** — ideally ≤ 8 Chinese characters or ≤ 5 English words. The model renders short quoted text far more reliably than long strings. e.g. `large bold headline text "3天涨粉1万" in the upper third`.
- **One clear subject / focal point**, described concretely (a person's expression, a product, a scene). Covers with a single strong subject out-click busy ones.
- **High contrast + eye-catching color**, and say where the title sits (leave clean negative space for it): "bold sans-serif, high contrast, title in the top third, subject centered".
- **Match the platform's vibe:**
  - 小红书 (xiaohongshu): clean, aesthetic, lifestyle; soft light; tidy layout; often a real-life or flat-lay scene.
  - 微信公众号 (wechat): professional, editorial, calm; a clear concept illustration; restrained palette.
  - 抖音 / TikTok (douyin / tiktok): loud, punchy, high-energy; exaggerated expression; saturated colors; big title.
  - YouTube: high-contrast "thumbnail" energy; a face with strong emotion or a bold object; a huge 3–5 word title; arrows/circles optional.
- **Do not name the platform brand inside the image.** Describe the look, not "a TikTok cover".

Example prompt (YouTube): `Bold YouTube-thumbnail-style image: a wide-eyed creator pointing at a glowing holographic AI chip, dramatic rim lighting, saturated teal-and-orange, large bold sans-serif headline text "AI 抢走你的工作?" across the top third, high contrast, clean composition.`

## Platform sizes (handled for you)

The script sends the platform's aspect ratio to the model (it snaps to the nearest supported bucket) and then crops the result to these exact pixels:

| `--platform`   | Platform            | Output size   |
| -------------- | ------------------- | ------------- |
| `xiaohongshu`  | 小红书 封面           | 1080 × 1440 (3:4) |
| `wechat`       | 微信公众号 头图        | 1080 × 459 (2.35:1) |
| `douyin`       | 抖音 封面             | 1080 × 1920 (9:16) |
| `tiktok`       | TikTok cover        | 1080 × 1920 (9:16) |
| `youtube`      | YouTube thumbnail   | 1280 × 720 (16:9) |
| `all`          | all five at once    | — |

## Usage

```bash
# One platform
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/cover.mjs \
  --platform youtube \
  --prompt 'Bold thumbnail: wide-eyed creator pointing at a glowing AI chip, dramatic lighting, saturated teal/orange, large bold headline "AI 抢走你的工作?" across the top third, high contrast' \
  --out ./covers

# All five platforms from the same idea (adjust the prompt per orientation if you want)
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/cover.mjs \
  --platform all \
  --prompt '...your cover prompt with the title text in quotes...' \
  --out ./covers
```

Defaults: `--model gpt-image-2-all`, `--quality low`, `--resolution 1K`. Raise `--quality` (medium/high) or `--resolution` (2K/4K) for a sharper cover at higher cost.

## Notes

- The script prints the saved path for each platform (`{platform}-cover.png`), plus a `-raw.png` before cropping.
- For portrait platforms (抖音/TikTok/小红书) the prompt should compose the subject and title **vertically**; for YouTube/公众号, **horizontally**. When doing `--platform all`, a single prompt works, but a per-orientation prompt looks best.
- Generated files on apimodels.app expire after **7 days** — the script downloads them locally immediately, so keep the local copies.
- Estimate cost first at <https://apimodels.app/tools>; browse models at <https://apimodels.app/models>.

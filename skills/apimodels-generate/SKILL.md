---
name: apimodels-generate
description: Generate images, videos, or speech (text-to-speech) through apimodels.app using one API key. Use when the user asks to create/generate an image, a video, or to turn text into speech/audio, and an apimodels.app key is available. Covers models like gpt-image-2, Gemini, Seedance 2.0, Veo, Kling, Grok Video, and MiniMax speech.
---

# apimodels-generate

Generate **images, videos, and speech** via [apimodels.app](https://apimodels.app) — one API key, many models, billed per successful generation in USD.

## Prerequisites

- An apimodels.app API key in the environment: `APIMODELS_API_KEY` (get one at <https://apimodels.app/console/api-keys>).
- Node.js 18+ (for the bundled script's `fetch`).

If `APIMODELS_API_KEY` is not set, ask the user to export it before continuing.

## How to use

Run the bundled script `scripts/generate.mjs`. It submits the job, polls until it finishes, and prints the resulting URL(s) to stdout (one per line). Video can take a few minutes.

### Generate an image

```bash
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/generate.mjs \
  --type image --prompt "a red fox in snow, cinematic" --model gpt-image-2 --aspect_ratio 16:9
```

- Common image models: `gpt-image-2` ($0.025), `gpt-image-2-lite` ($0.008, cheapest), `gemini-3-pro-image`, `gemini-2.5-flash-image`.
- Optional: `--aspect_ratio` (1:1, 16:9, 9:16), `--resolution` (1K, 2K, 4K), `--image_url` (for image-to-image edits).

### Generate a video

```bash
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/generate.mjs \
  --type video --prompt "a timelapse of a city at night" --model seedance-2.0-fast --resolution 720p --duration 5
```

- Common video models: `seedance-2.0-fast`, `seedance-2.0`, `veo-3.1-fast-fhd` ($0.07 flat, cheapest), `veo-3.1`, `grok-video-3`, `kling-v2-6`.
- Use the **dotted** public names. The bare internal forms (`seedance-2-fast`, `seedance-2`) appear in `GET /api/v1/models` but the generation endpoint rejects them with "Invalid model".
- Optional: `--aspect_ratio`, `--resolution` (480p/720p/1080p), `--duration` (seconds), `--image_url` (first-frame / reference image for image-to-video).

### Text to speech

```bash
APIMODELS_API_KEY=$APIMODELS_API_KEY node scripts/generate.mjs \
  --type tts --text "Hello from apimodels" --model minimax-speech-02-turbo --voice_id English_Trustworthy_Man
```

- Common TTS models: `minimax-speech-02-turbo`, `minimax-speech-02-hd`, `minimax-speech-2.8-hd`.
- `--voice_id` defaults to `English_Trustworthy_Man`. List all with `GET https://api.apimodels.app/v1/minimax/voices`.
- The `eleven-tts-*` models are **not** reachable from this script: they stream raw audio from `POST /api/v1/tts/stream` rather than returning a task URL.

## Notes

- The script prints result URL(s). Share them with the user, or download with `curl -O <url>`.
- Result files are kept for **7 days**, then auto-deleted — download anything worth keeping.
- To discover exact model ids, the user can browse <https://apimodels.app/models> or call `GET https://api.apimodels.app/v1/models`.
- To estimate cost before generating, point the user to the calculators at <https://apimodels.app/tools>.

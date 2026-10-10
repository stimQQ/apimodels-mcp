---
name: apimodels-media
description: Create videos, images and voice-over with the apimodels MCP tools (generate_video, generate_image, text_to_speech, get_task, get_balance). Use whenever the user wants to generate, animate or edit an image or a video, needs AI visuals or narration for a project, or wants a multi-shot video planned from a brief, script or storyboard and rendered (ads, product shots, social clips, explainers). Models include Seedance, Veo, Kling, MiniMax Hailuo, Wan, Grok Imagine, GPT Image, Nano Banana, Seedream, ElevenLabs and MiniMax speech.
---

# Making media with apimodels

You plan, apimodels renders. Do the thinking yourself — brief, script, shot list, prompts, file handling, editing — and call the apimodels tools only for the generation. Each generation is billed to the user's apimodels balance in USD; failed generations are not billed.

## Tools

| Tool | What it does | Billed |
|---|---|---|
| `get_balance` | Account balance (USD) | no |
| `list_models` | Current model ids, grouped by type | no |
| `generate_image` | Text to image; edit an image (pass `image_url`); transparent background / layer split on `doubao-seedream-5-0-flash` | yes |
| `generate_video` | Text to video; image to video (`image_url` = first frame) | yes |
| `text_to_speech` | Narration / voice-over | yes |
| `get_task` | Finish a task that came back STILL RUNNING | no |
| `review_image` | A vision model checks an image against your brief | yes, small |
| `chat` | Ask another LLM on apimodels | yes |

## If the apimodels tools are missing

The tools come from a small local server that runs on Node.js. If none of them are available — or the user installed this plugin and nothing happens — set it up for them instead of sending them off to read docs:

1. Run `node -v`.
2. **No Node.js:** offer to install the official Node.js LTS from nodejs.org, say what you are about to run, and run it once they agree. The user only has to confirm the system prompt.
   - Windows 10 / 11 (Windows asks once for permission; the user clicks Yes):
     ```powershell
     winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
     ```
   - macOS (opens Apple's installer; the user clicks Continue, then Install, and enters their Mac password):
     ```bash
     PKG=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -oE 'node-v[0-9.]+\.pkg' | head -1)
     curl -fL -o "$HOME/Downloads/$PKG" "https://nodejs.org/dist/latest-v24.x/$PKG" && open "$HOME/Downloads/$PKG"
     ```
     If Homebrew is installed, `brew install node` also works.
   - Linux: the distribution's package manager (`sudo apt install nodejs npm`, `sudo dnf install nodejs`).
   - If you cannot run commands or reach the network, give the user https://nodejs.org/en/download and the same steps.
3. After Node.js is installed, the user must **restart the agent app** (Codex, Claude Code, …) so the apimodels server starts.
4. **Node.js is there but the tools are still missing:** run `npx -y apimodels-mcp status`. It reports whether an API key is configured and whether it works. If there is no key, the user runs `npx -y apimodels-mcp login` in their own terminal (it asks for the key, checks it and saves it); no restart is needed after that.

## Rules

1. **Generation is asynchronous.** A `generate_*` call waits up to `wait_seconds` (default 50). If the job is not done it returns `STILL RUNNING` and a task id: call `get_task` with that id until it returns the URL. Never submit the same job again — that bills twice. Video takes a median of about 2.5 minutes, 9 in 10 within 8 minutes.
2. **Ask before spending at volume.** One image or one clip the user asked for: just do it. More than three videos, or anything the user did not ask for explicitly: list what you will render and ask first. To estimate cost, check `get_balance` before and after the first item and multiply; prices per model are on `https://apimodels.app/models/<model-id>`. Do not make up prices.
3. **Never handle the key in chat.** If a tool says no API key is configured, tell the user to run `npx -y apimodels-mcp login` in a terminal (keys: https://apimodels.app/console/api-keys). Do not ask them to paste the key into the conversation.
4. **Files.** `image_url` accepts a public URL, a local file path or a data URI; local files are uploaded for you. When working in a project, download every result into it right away (`curl -L -o assets/shot01.mp4 <url>`) — result links are not permanent.
5. **People.** Some video models reject photos of real people as a reference or first frame (Seedance in particular). Use a generated character or another model instead of retrying the same photo.

## Picking a model

`list_models` has the full, current list. Sensible defaults:

**Video** (`generate_video`)
- `seedance-2.0-fast` — the tool's default; good motion and prompt following, quick turnaround.
- `seedance-2.5`, `seedance-2.0` — higher quality, slower.
- `veo-3.1-fast-fhd` — Google Veo 3.1 Fast at 1080p, the lowest-priced flat-rate option.
- `gemini-omni-video-lite` — short clips, fast.
- `kling-v2-6`, `kling-v3-omni` — Kling.
- `minimax-h3` — MiniMax Hailuo H3, takes several reference images; `minimax-h3-lite` — up to 768p at a lower price.
- `wan-3.0-video`, `grok-imagine-video-1.5`, `ltx-2.3`.

**Image** (`generate_image`)
- `gpt-image-2`, `gpt-image-2.5-flare` — follow long prompts, render text, edit with `image_url`.
- `nano-banana-2-1`, `gemini-3-pro-image` — Google image models; strong at text and edits.
- `doubao-seedream-5-0-flash` — transparent backgrounds and layer splitting.

**Speech** (`text_to_speech`): default `minimax-speech-02-turbo`; also `minimax-speech-2.8-hd`, `eleven-tts-v3`, `fish-s2.1-pro`.

Match the aspect ratio to where the result will be used: 16:9 for YouTube and landscape screens, 9:16 for TikTok / Reels / Shorts / Douyin, 1:1 for feeds.

## Multi-shot videos — where you add the most

1. **Plan.** Turn the brief into a script and a shot list: one line per shot with duration (keep each shot within what the model renders in one clip, usually 5–10 s), framing, action and transition. Show it to the user and confirm before rendering anything.
2. **Look.** Make one keyframe per shot with `generate_image`, in the final aspect ratio. For a recurring character or product, generate it once and pass that image as `image_url` when making the other frames so it stays consistent. Check frames with `review_image` (or the preview, if your client shows tool images) and fix them before animating — a bad frame is cheaper to redo than a bad clip.
3. **Motion.** For each shot call `generate_video` with `image_url` set to its keyframe (a local path is fine). Describe only the motion and camera in the prompt; the frame already fixes the look. Submit the shots, keep the task ids, then collect each with `get_task`.
4. **Voice.** Narration with `text_to_speech`, one call per paragraph so timing stays editable.
5. **Assemble locally** with ffmpeg, if it is installed:
   ```bash
   # shots.txt lists the clips in order:  file 'shot01.mp4'  (one per line)
   ffmpeg -f concat -safe 0 -i shots.txt -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -pix_fmt yuv420p -an video.mp4
   ffmpeg -i video.mp4 -i narration.mp3 -c:v copy -c:a aac -shortest final.mp4
   ```
   Clips from different models differ in size and frame rate, which is why the first command re-encodes instead of `-c copy`.
6. **Report** the files you produced, the models used and what it cost (balance before minus after).

## When something fails

- `FAILED … retryable`: a transient upstream problem; retrying once is reasonable.
- A content-policy rejection: rephrase the prompt or change the reference image; do not resubmit it unchanged.
- `apimodels API error (HTTP 402)`: the balance is too low — tell the user to top up at https://apimodels.app/console/credits.
- No apimodels tools at all: the plugin's MCP server did not start. It needs Node.js (`npx -v` should print a version); after installing Node, restart the agent.

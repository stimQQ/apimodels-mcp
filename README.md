# apimodels-mcp

MCP server for [apimodels.app](https://apimodels.app) — call **image, video, LLM chat and text-to-speech** models with one API key, from Claude Desktop, Cursor, or any MCP client.

One key unlocks GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, Seedance, Veo, Kling, gpt-image-2, Gemini Image, MiniMax speech and more — billed in USD, you only pay for successful generations.

## Fastest setup: the Codex / Claude Code plugin

Coding agents are good at planning — scripts, shot lists, prompts, editing with ffmpeg. The **apimodels plugin** gives them the part they cannot do: rendering the video, images and voice-over. It bundles this MCP server plus a skill that teaches the agent when to use it, how to pick a model, how to wait for long renders and when to ask before spending.

1. **Save your API key once** (needs [Node.js](https://nodejs.org/en/download) 18+; get a key at <https://apimodels.app/console/api-keys>):
   ```bash
   npx -y apimodels-mcp login
   ```
   It checks the key and stores it in `~/.apimodels/credentials.json`, where every client finds it — including desktop apps that do not see your shell's environment variables.
2. **Install the plugin.**
   - Claude Code (2.1.275 or later):
     ```
     /plugin install apimodels --marketplace stimQQ/apimodels-mcp
     ```
     Older versions: `/plugin marketplace add stimQQ/apimodels-mcp`, then `/plugin install apimodels@apimodels`.
   - Codex:
     ```bash
     codex plugin marketplace add stimQQ/apimodels-mcp
     codex plugin add apimodels@apimodels
     ```
     Then restart Codex. Codex asks you to approve each call that spends credits (`generate_video`, `generate_image`, `text_to_speech`, `chat`, `review_image`); checking progress, the model list and the balance never asks.
3. **Ask in plain words**, e.g. *"make a 5-second 16:9 video of a kitten slowly raising its head in morning light"* or *"plan a 20-second product video for this repo and render it shot by shot"*.

No Node.js yet? Install the plugin anyway and ask for a video: the skill has the agent check for Node.js and, with your OK, install the official LTS for you (`winget` on Windows, Apple's installer on macOS).

## Tools

| Tool | What it does |
|------|--------------|
| `get_balance` | Your apimodels balance in USD — the agent checks it before a batch. |
| `list_models` | List available model ids (chat / image / video / audio). |
| `chat` | Chat / text completion with any LLM (`gpt-5-5`, `claude-opus-4-8`, `gemini-3-pro-preview`, …). |
| `generate_image` | Text-to-image or image edit; returns the image URL(s) plus a downscaled preview the model can look at. With `doubao-seedream-5-0-flash` it can also keep a transparent background (`background: "transparent"`) or split one image into a base plus up to 16 transparent layers with names and positions (`layer_decomposition: true`, billed per output image). |
| `review_image` | A vision model critiques an image against your brief and proposes a revised prompt. |
| `generate_video` | Text-to-video (optional reference image); returns the video URL(s), or a task id if it is not done within `wait_seconds`. |
| `get_task` | Wait for / check on a task that `generate_image`, `generate_video` or `text_to_speech` handed back as still running. |
| `text_to_speech` | Text-to-speech (MiniMax voices); returns the audio URL. ElevenLabs TTS is not exposed here — it streams raw bytes from `POST /v1/tts/stream` rather than returning a URL. |

### Long generations do not get lost

Every generation is asynchronous on apimodels, and video is slow: a median of about 2.5 minutes, 9 in 10 within 8 minutes (production, week to 2026-09-22). Images take about 50 seconds. Meanwhile Codex aborts an MCP tool call after 60 seconds by default, and the MCP SDK's own client timeout is 60 seconds too. A tool that blocks until the video is ready therefore gets killed mid-wait — the task keeps running, the account is billed when it finishes, and the assistant never sees the URL. Versions up to 0.2.x did exactly that.

Since 0.3.0 the generation tools wait at most `wait_seconds` (default 50) and then return the task id with a "still running" note; the assistant calls `get_task`, which waits up to another `wait_seconds` and returns the URL(s) — with the image preview for image tasks — or "still running" again. Nothing is resubmitted and nothing is billed twice. The assistant does this on its own; you just ask for the video.

- **Codex**: keep the default. Or raise `tool_timeout_sec` for this server in `config.toml` and pass a larger `wait_seconds`.
- **Claude Code / Claude Desktop / Cursor**: no 60-second limit, so `wait_seconds: 600` on `generate_video` gets the URL in one call. `APIMODELS_WAIT_SECONDS=600` in the server's env makes that the default.

### The model can check its own work

Ask for an image and let the assistant iterate until it is right — "make a 16:9 banner that says SAVE 10%, check the spelling, fix it if needed":

1. `generate_image` returns the URL **and a preview of the image itself** (max 1024px JPEG). Clients that pass tool-result images to the model — Claude Desktop, Claude Code, Cursor — let it see what it made. Pass `return_image: false` to skip the preview.
2. `review_image` works everywhere, including clients that show tool-result images to you but not to the model (Cherry Studio is one). It sends the image and your brief to a vision model and returns what matches, what is wrong (garbled text, composition, aspect ratio, artifacts) and a revised prompt. One review costs well under $0.01 on the default `gpt-5.6-luna`.

The assistant picks `aspect_ratio` and `resolution` itself from what you ask for, so "make it 16:9" in plain words is enough.

### Local images just work

`image_url` on `generate_image` and `generate_video` takes any of these:

- a public `https://…` URL — passed through untouched
- **a local file path** — `/Users/me/photo.png`, `./ref.jpg`, `~/Pictures/x.webp`
- **a URL on your own machine** — `http://127.0.0.1:8000/photo.png`, `http://localhost:3000/…`
- a `data:image/png;base64,…` URI

The last three are uploaded for you first, and the resulting public URL is what gets
generated from. This has to happen here rather than server-side: the file exists only on
your machine, and `127.0.0.1` means *our* server when our server resolves it — which is why
passing one to the REST API directly fails with `private/reserved IP addresses not allowed`.
This MCP server runs next to your files, so it can do what our servers cannot.

Uploads land in your account's R2 space and are auto-deleted after 7 days.

## Setup

1. Get an API key at <https://apimodels.app/console/api-keys> (it looks like `sk_…`) and save it with `npx -y apimodels-mcp login` — or put it in the server's environment as `APIMODELS_API_KEY`, as the examples below do.
2. Add the server to your MCP client. `npx -y apimodels-mcp status` shows which key is in use and your balance.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "apimodels": {
      "command": "npx",
      "args": ["-y", "apimodels-mcp"],
      "env": {
        "APIMODELS_API_KEY": "sk_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You can now ask it to "generate an image of …" or "make a 5-second video of …".

### Cursor

`Settings → MCP → Add new MCP server`, or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "apimodels": {
      "command": "npx",
      "args": ["-y", "apimodels-mcp"],
      "env": { "APIMODELS_API_KEY": "sk_your_key_here" }
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.apimodels]
command = "npx"
args = ["-y", "apimodels-mcp"]
env = { APIMODELS_API_KEY = "sk_your_key_here" }
# Optional. Codex aborts a tool call after 60 s by default; the tools stay under that
# on their own (see "Long generations do not get lost"), so this is only needed if you
# want generate_video to return the URL in one call — then also pass wait_seconds: 600.
# tool_timeout_sec = 660
```

Two things to know in Codex:

- **Approvals.** Codex asks you to approve any tool call that is not marked read-only. Since 0.4.3, `list_models` and `get_task` are marked read-only, so waiting on a video no longer prompts on every check; the tools that bill your account (`generate_video`, `generate_image`, `text_to_speech`, `chat`, `review_image`) still ask once per call. To skip those prompts as well, add `default_tools_approval_mode = "approve"` under `[mcp_servers.apimodels]`.
- **Name the tool.** Codex loads MCP tools on demand rather than listing them all up front, so say which one you want — e.g. *"use apimodels generate_video to make a 5-second 16:9 clip of …"*. A bare "make me a video" may not make it look.

### Cherry Studio

In `Settings → MCP Servers`, add a new server of type **stdio**:

- Command: `npx`
- Arguments: `-y apimodels-mcp`
- Environment variables: `APIMODELS_API_KEY=sk_your_key_here`

Enable the server, then select it for your conversation from the MCP control under the chat box. Use a chat model that supports tool calls (Claude, GPT, Gemini …) as the conversation model — it calls the image model for you. Cherry Studio needs Node.js installed for `npx`; on Windows install it from <https://nodejs.org>.

Any other MCP client works the same way — run `npx -y apimodels-mcp` over stdio with `APIMODELS_API_KEY` in the environment.

## Models, docs and pricing

Everything the tools call is documented on apimodels.app:

- [API documentation](https://apimodels.app/docs) · [pricing](https://apimodels.app/pricing) · [full model catalog](https://apimodels.app/models)
- Image: [GPT Image 2.5 API](https://apimodels.app/docs/gpt-image-2-5) ([model page](https://apimodels.app/models/gpt-image-2.5-flare)), [GPT Image 2 API](https://apimodels.app/docs/gpt-image-2), [Nano Banana 2.1 API](https://apimodels.app/docs/nano-banana-2-1) ([model page](https://apimodels.app/models/nano-banana-2-1)), [all image models](https://apimodels.app/docs/image)
- Video: [Seedance 2.5 API](https://apimodels.app/docs/seedance-2-5), [Google Veo API](https://apimodels.app/docs/google-veo), [MiniMax H3 API](https://apimodels.app/docs/minimax-h3), [FlashVSR video upscaling](https://apimodels.app/docs/flashvsr)
- Chat and speech: [LLM API (GPT, Claude, Gemini, DeepSeek, GLM, Qwen)](https://apimodels.app/docs/llm), [Claude Sonnet 5.5](https://apimodels.app/models/claude-sonnet-5-5), [audio and text-to-speech](https://apimodels.app/docs/audio)
- Other ways in: [Claude Code setup](https://apimodels.app/docs/claude-code), [chat clients](https://apimodels.app/docs/clients), [Agent Skills](https://apimodels.app/docs/skills), [free calculators and tools](https://apimodels.app/tools)
- Prompt libraries with example outputs: [GPT Image 2.5 prompts](https://apimodels.app/gpt-image-2-5-prompts), [GPT Image 2 prompts](https://apimodels.app/gpt-image-2-prompts), [Seedance 2.5 prompts](https://apimodels.app/seedance-2-5-prompts), [MiniMax H3 prompts](https://apimodels.app/minimax-h3-prompts)

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `APIMODELS_API_KEY` | — | Your `sk_…` key. Optional when you have run `apimodels-mcp login`; if both exist, this one wins. |
| `APIMODELS_CREDENTIALS_FILE` | `~/.apimodels/credentials.json` | Where `apimodels-mcp login` saves the key and where the server looks for it. |
| `APIMODELS_BASE_URL` | `https://api.apimodels.app/v1` | API base URL. |
| `APIMODELS_WAIT_SECONDS` | `50` | Default `wait_seconds` for `generate_image`, `generate_video`, `text_to_speech` and `get_task`: how long a call waits before handing back a task id. Max 900. |
| `APIMODELS_TIMEOUT_MS` | — | Deprecated (0.2.x): the same wait in milliseconds. Still honoured if set. |

## Local development

```bash
pnpm install
pnpm build
APIMODELS_API_KEY=sk_... node dist/index.js   # runs over stdio
```

## License

MIT

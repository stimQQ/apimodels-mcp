# apimodels-mcp

MCP server for [apimodels.app](https://apimodels.app) — call **image, video, LLM chat and text-to-speech** models with one API key, from Claude Desktop, Cursor, or any MCP client.

One key unlocks GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, Seedance, Veo, Kling, gpt-image-2, Gemini Image, MiniMax speech and more — billed in USD, you only pay for successful generations.

## Tools

| Tool | What it does |
|------|--------------|
| `list_models` | List available model ids (chat / image / video / audio). |
| `chat` | Chat / text completion with any LLM (`gpt-5-5`, `claude-opus-4-8`, `gemini-3-pro-preview`, …). |
| `generate_image` | Text-to-image or image edit; returns the image URL(s) plus a downscaled preview the model can look at. |
| `review_image` | A vision model critiques an image against your brief and proposes a revised prompt. |
| `generate_video` | Text-to-video (optional reference image); returns the video URL(s). |
| `text_to_speech` | Text-to-speech (MiniMax voices); returns the audio URL. ElevenLabs TTS is not exposed here — it streams raw bytes from `POST /v1/tts/stream` rather than returning a URL. |

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

1. Get an API key at <https://apimodels.app/console/api-keys> (it looks like `sk_…`).
2. Add the server to your MCP client.

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
- Image: [GPT Image 2.5 API](https://apimodels.app/docs/gpt-image-2-5) ([model page](https://apimodels.app/models/gpt-image-2.5-flare)), [GPT Image 2 API](https://apimodels.app/docs/gpt-image-2), [all image models](https://apimodels.app/docs/image)
- Video: [Seedance 2.5 API](https://apimodels.app/docs/seedance-2-5), [Google Veo API](https://apimodels.app/docs/google-veo), [MiniMax H3 API](https://apimodels.app/docs/minimax-h3), [FlashVSR video upscaling](https://apimodels.app/docs/flashvsr)
- Chat and speech: [LLM API (GPT, Claude, Gemini, DeepSeek, GLM, Qwen)](https://apimodels.app/docs/llm), [audio and text-to-speech](https://apimodels.app/docs/audio)
- Other ways in: [Claude Code setup](https://apimodels.app/docs/claude-code), [chat clients](https://apimodels.app/docs/clients), [Agent Skills](https://apimodels.app/docs/skills), [free calculators and tools](https://apimodels.app/tools)
- Prompt libraries with example outputs: [GPT Image 2.5 prompts](https://apimodels.app/gpt-image-2-5-prompts), [GPT Image 2 prompts](https://apimodels.app/gpt-image-2-prompts), [Seedance 2.5 prompts](https://apimodels.app/seedance-2-5-prompts), [MiniMax H3 prompts](https://apimodels.app/minimax-h3-prompts)

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `APIMODELS_API_KEY` | — (required) | Your `sk_…` key. |
| `APIMODELS_BASE_URL` | `https://api.apimodels.app/v1` | API base URL. |
| `APIMODELS_TIMEOUT_MS` | `300000` | Max time to poll an async (image/video/audio) task. |

## Local development

```bash
pnpm install
pnpm build
APIMODELS_API_KEY=sk_... node dist/index.js   # runs over stdio
```

## License

MIT

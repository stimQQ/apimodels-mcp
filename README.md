# apimodels-mcp

MCP server for [apimodels.app](https://apimodels.app) — call **image, video, LLM chat and text-to-speech** models with one API key, from Claude Desktop, Cursor, or any MCP client.

One key unlocks GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, Seedance, Veo, Kling, gpt-image-2, Gemini Image, MiniMax speech and more — billed in USD, you only pay for successful generations.

## Tools

| Tool | What it does |
|------|--------------|
| `list_models` | List available model ids (chat / image / video / audio). |
| `chat` | Chat / text completion with any LLM (`gpt-5-5`, `claude-opus-4-8`, `gemini-3-pro-preview`, …). |
| `generate_image` | Text-to-image or image edit; returns the image URL(s). |
| `generate_video` | Text-to-video (optional reference image); returns the video URL(s). |
| `text_to_speech` | Text-to-speech (MiniMax voices); returns the audio URL. ElevenLabs TTS is not exposed here — it streams raw bytes from `POST /v1/tts/stream` rather than returning a URL. |

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

Any other MCP client works the same way — run `npx -y apimodels-mcp` over stdio with `APIMODELS_API_KEY` in the environment.

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

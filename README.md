# apimodels-mcp

MCP server for [apimodels.app](https://apimodels.app) — call **image, video, LLM chat and text-to-speech** models with one API key, from Claude Desktop, Cursor, or any MCP client.

One key unlocks GPT-5.5, Claude, Gemini, GLM, DeepSeek, Qwen, Seedance, Veo, Kling, gpt-image-2, nanobanana, ElevenLabs and more — billed in USD, you only pay for successful generations.

## Tools

| Tool | What it does |
|------|--------------|
| `list_models` | List available model ids (chat / image / video / audio). |
| `chat` | Chat / text completion with any LLM (`gpt-5-5`, `claude-opus-4-8`, `gemini-3-pro-preview`, …). |
| `generate_image` | Text-to-image or image edit; returns the image URL(s). |
| `generate_video` | Text-to-video (optional reference image); returns the video URL(s). |
| `text_to_speech` | Text-to-speech; returns the audio URL. |

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
| `APIMODELS_BASE_URL` | `https://apimodels.app/api/v1` | API base URL. |
| `APIMODELS_TIMEOUT_MS` | `300000` | Max time to poll an async (image/video/audio) task. |

## Local development

```bash
npm install
npm run build
APIMODELS_API_KEY=sk_... node dist/index.js   # runs over stdio
```

## License

MIT

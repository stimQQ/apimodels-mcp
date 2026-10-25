# Installing apimodels-mcp (guide for AI agents)

apimodels-mcp gives an MCP client image generation and editing, video generation, text-to-speech and LLM chat through one [apimodels.app](https://apimodels.app) account. There are two ways to install it. Prefer the hosted server: nothing to install and no key to handle.

Never ask the user to paste an API key into the chat, and never write a key into a file inside a project or repository.

## Option A: hosted server (recommended, no Node.js)

Endpoint: `https://api.apimodels.app/mcp` (Streamable HTTP, OAuth).

Cline CLI:

```bash
cline mcp install apimodels --transport http https://api.apimodels.app/mcp
```

Cline in VS Code: add this to `cline_mcp_settings.json` (MCP Servers → Configure):

```json
{
  "mcpServers": {
    "apimodels": {
      "type": "streamableHttp",
      "url": "https://api.apimodels.app/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Then run the server's OAuth authorization. A browser window opens on apimodels.app; the user signs in (or signs up) and clicks **Authorize**. The token is a dedicated API key named `MCP · <app> · <date>`, which the user can delete in the console to disconnect.

The hosted server cannot read files on the user's machine. To use a local image as a reference, call `get_upload_url`, upload the file with `curl -T <file> "<upload url>"`, and pass the returned public URL as `image_url`.

## Option B: local server (Node.js 18 or later)

1. Check `node --version`. If it is older than 18 or missing, ask the user before installing Node.js.
2. Sign in once:

   ```bash
   npx -y apimodels-mcp login
   ```

   The browser opens apimodels.app; the user clicks **Authorize**. The key is stored in `~/.apimodels/credentials.json`, where the server finds it. Without a browser, use `npx -y apimodels-mcp login --no-browser` (prints a link) or `--paste` (the user pastes a key from https://apimodels.app/console/api-keys into the terminal prompt, not into the chat).
3. Add the server to `cline_mcp_settings.json`:

   ```json
   {
     "mcpServers": {
       "apimodels": {
         "command": "npx",
         "args": ["-y", "apimodels-mcp"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   If the user prefers an environment variable, add `"env": { "APIMODELS_API_KEY": "sk_..." }` with a key they enter themselves.

The local server also accepts local file paths and `http://localhost` URLs as `image_url` and uploads them first.

## Check that it works

1. Call `get_balance`. It returns the account balance in USD. An authentication error means the OAuth authorization (Option A) or `login` (Option B) was not completed.
2. Call `list_models` (no arguments) to see the model ids, grouped by chat, image, video and audio.
3. Optional: `npx -y apimodels-mcp status` (local server) shows which key is in use and the balance.

## Spending

`generate_image`, `generate_video`, `text_to_speech`, `chat` and `review_image` spend account credit; failed generations are not charged. Confirm with the user before large batches or long videos. A generation that is still running returns a task id: call `get_task` with it instead of generating again, so the user is not billed twice.

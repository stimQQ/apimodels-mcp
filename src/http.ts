/**
 * `apimodels-mcp serve` — the hosted (remote) MCP server, e.g. https://api.apimodels.app/mcp.
 *
 * Why a hosted server at all (0.7.0): the local server needs Node.js on the user's machine
 * and a key saved there. The hosted one needs neither — the client connects by URL and
 * signs in with OAuth (authorization server: apimodels.app, see the nextjs /oauth/* routes;
 * the access token it issues is an ordinary apimodels API key). It is also the only way in
 * for web clients such as ChatGPT and Claude.ai connectors.
 *
 * Shape:
 *   POST /mcp                                   Streamable HTTP, stateless: one McpServer + transport per request
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata pointing at the authorization server
 *   PUT|POST /upload/<token>?name=…             takes a local file the agent uploads with curl (see upload-token.ts)
 *   GET  /healthz
 * No bearer token → 401 with WWW-Authenticate: Bearer resource_metadata=…, which is how MCP clients
 * discover where to sign in. Tokens are checked against GET /v1/balance (cached briefly).
 *
 * Safety: in this mode the tools never read files or private URLs (runtime.remote, enforced in
 * resolveImageInput) — a path in a tool argument would otherwise be a file read on our server.
 * Waits are capped (runtime.waitCap) because a silent response longer than ~100 s is cut by
 * Cloudflare; the generation tools hand back a task id instead, as they do for Codex.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AsyncLocalStorage } from 'node:async_hooks'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { openUploadToken } from './upload-token.js'

export interface ServeDeps {
  buildServer: () => McpServer
  requestKey: AsyncLocalStorage<{ key: string }>
  apiBaseUrl: string
  uploadBytes: (buf: Buffer, filename: string, contentType: string) => Promise<string>
  guessMime: (name: string) => string
}

const MAX_JSON_BYTES = 25 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const VALID_TTL_MS = 5 * 60_000
const INVALID_TTL_MS = 60_000

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extra })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) return null
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function serve(deps: ServeDeps, port: number): Promise<void> {
  const publicUrl = (process.env.MCP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')
  const authServer = (process.env.MCP_AUTH_SERVER || 'https://apimodels.app').replace(/\/$/, '')
  const resourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`
  const metadata = {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [authServer],
    bearer_methods_supported: ['header'],
    resource_name: 'apimodels',
    resource_documentation: 'https://apimodels.app/docs/mcp',
  }

  // token → valid-until / invalid-until. Keyed by hash so raw keys are not kept around as map keys.
  const seen = new Map<string, { ok: boolean; until: number }>()
  async function tokenOk(token: string): Promise<boolean> {
    const h = createHash('sha256').update(token).digest('hex')
    const hit = seen.get(h)
    if (hit && hit.until > Date.now()) return hit.ok
    let ok = false
    try {
      const r = await fetch(`${deps.apiBaseUrl}/balance`, { headers: { Authorization: `Bearer ${token}` } })
      ok = r.ok
    } catch {
      return false // upstream hiccup: do not cache, let the client retry
    }
    if (seen.size > 10_000) seen.clear()
    seen.set(h, { ok, until: Date.now() + (ok ? VALID_TTL_MS : INVALID_TTL_MS) })
    return ok
  }

  const unauthorized = (res: ServerResponse, invalid: boolean) =>
    sendJson(res, 401, { error: invalid ? 'invalid_token' : 'unauthorized', error_description: invalid ? 'The access token is invalid or was revoked.' : 'Sign in to apimodels to use this server.' }, {
      'WWW-Authenticate': `Bearer${invalid ? ' error="invalid_token",' : ''} resource_metadata="${resourceMetadataUrl}"`,
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const path = url.pathname
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return }
      if (path === '/healthz') { sendJson(res, 200, { ok: true }); return }
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
        sendJson(res, 200, metadata, { 'Cache-Control': 'public, max-age=3600' }); return
      }

      if (path.startsWith('/upload/')) {
        if (req.method !== 'PUT' && req.method !== 'POST') { sendJson(res, 405, { error: 'use PUT (curl -T) or POST' }, { Allow: 'PUT, POST' }); return }
        const key = openUploadToken(path.slice('/upload/'.length))
        if (!key) { sendJson(res, 403, { error: 'This upload link is invalid or has expired. Ask for a new one with get_upload_url.' }); return }
        const buf = await readBody(req, MAX_UPLOAD_BYTES)
        if (!buf) { sendJson(res, 413, { error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }); return }
        if (!buf.length) { sendJson(res, 400, { error: 'Empty upload.' }); return }
        const name = (url.searchParams.get('name') || 'upload.bin').replace(/[^\w.\-]/g, '_').slice(0, 120)
        const declared = String(req.headers['content-type'] || '').split(';')[0].trim()
        const type = declared && declared !== 'application/octet-stream' && declared !== 'application/x-www-form-urlencoded' ? declared : deps.guessMime(name)
        const publicFileUrl = await deps.requestKey.run({ key }, () => deps.uploadBytes(buf, name, type))
        sendJson(res, 200, { url: publicFileUrl })
        return
      }

      if (path === '/mcp' || path === '/mcp/') {
        if (req.method !== 'POST') {
          // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
          sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' }, id: null }, { Allow: 'POST' })
          return
        }
        const auth = String(req.headers.authorization || '')
        const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim()
        if (!token) { unauthorized(res, false); return }
        if (!(await tokenOk(token))) { unauthorized(res, true); return }
        const raw = await readBody(req, MAX_JSON_BYTES)
        if (!raw) { sendJson(res, 413, { jsonrpc: '2.0', error: { code: -32000, message: 'Request too large.' }, id: null }); return }
        let body: unknown
        try { body = JSON.parse(raw.toString('utf8')) } catch {
          sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); return
        }
        const mcp = deps.buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}) })
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
        await mcp.connect(transport)
        await deps.requestKey.run({ key: token }, () => transport.handleRequest(req, res, body))
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (e) {
      console.error('[apimodels-mcp] http error:', e instanceof Error ? e.message : e)
      sendJson(res, 500, { error: 'internal error' })
    }
  })
  server.requestTimeout = 0 // long tool calls; the wait cap bounds them
  server.headersTimeout = 60_000
  await new Promise<void>((r) => server.listen(port, process.env.MCP_HOST || '127.0.0.1', () => r()))
  console.error(`[apimodels-mcp] hosted server on ${process.env.MCP_HOST || '127.0.0.1'}:${port} — public ${publicUrl}/mcp, auth ${authServer}`)
}

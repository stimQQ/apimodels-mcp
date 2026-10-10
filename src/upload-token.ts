/**
 * Short-lived upload links for the hosted server (`apimodels-mcp serve`).
 *
 * The hosted server cannot read the user's files, and the agent never holds the user's
 * key (the MCP client keeps the OAuth token). So `get_upload_url` hands the agent a link
 * of the form <public>/upload/<token> to `curl -T` the file to; the token is the caller's
 * key sealed with AES-256-GCM under MCP_UPLOAD_SECRET plus an expiry. The upload handler
 * opens it and forwards the bytes to POST /v1/files as that user. A leaked link only lets
 * someone upload a file to that account for 15 minutes — it cannot generate, spend or
 * read anything.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const UPLOAD_TTL_MS = 15 * 60_000

function secret(): Buffer {
  const s = process.env.MCP_UPLOAD_SECRET
  if (!s || s.length < 32) throw new Error('Uploads are not configured on this server (MCP_UPLOAD_SECRET).')
  return createHash('sha256').update(`apimodels-mcp-upload-v1|${s}`).digest()
}

export function makeUploadToken(apiKey: string, ttlMs = UPLOAD_TTL_MS): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', secret(), iv)
  const ct = Buffer.concat([c.update(JSON.stringify({ k: apiKey, e: Date.now() + ttlMs })), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')
}

/** The sealed key, or null when the token is forged, damaged or expired. */
export function openUploadToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', secret(), raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    const j = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as { k?: unknown; e?: unknown }
    if (typeof j.k !== 'string' || typeof j.e !== 'number' || j.e < Date.now()) return null
    return j.k
  } catch {
    return null
  }
}

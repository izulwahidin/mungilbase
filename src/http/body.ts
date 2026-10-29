import type { Context } from 'hono'
import { badRequest } from './errors.js'

/** Bodies are small JSON documents. Enforced before parsing. */
export const MAX_BODY_BYTES = 1_000_000

/**
 * Reads a JSON body with a hard size limit.
 *
 * Content-Length is checked first (cheap), then the actual bytes after reading
 * (a lying or absent header must not bypass the limit).
 */
export async function readJson(c: Context): Promise<unknown> {
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isFinite(length) || length < 0) throw badRequest('Invalid Content-Length')
    if (length > MAX_BODY_BYTES) throw badRequest(`Body must be at most ${MAX_BODY_BYTES} bytes`)
  }

  const text = await c.req.text()

  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw badRequest(`Body must be at most ${MAX_BODY_BYTES} bytes`)
  }

  if (!text.trim()) return {}

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw badRequest('Body must be valid JSON')
  }
}

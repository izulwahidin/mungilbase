import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Context, Hono } from 'hono'
import type { AppEnv } from './app.js'

export interface StaticOptions {
  dir: string
  spa?: boolean
  cacheControl?: string
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
}

/**
 * Paths that belong to MungilBase itself. A request under one of these must
 * never be answered with a frontend file: an unknown `/api/...` has to stay a
 * JSON 404 so clients do not parse HTML.
 */
const RESERVED = ['/api', '/admin', '/metrics', '/health', '/version']

/**
 * Serves a directory from the same origin as the API. Registered after every
 * built-in route, so `/api/*`, `/admin`, `/health`, `/version` and `/metrics`
 * always win.
 */
export function registerStaticRoutes(app: Hono<AppEnv>, options: StaticOptions): void {
  const root = resolve(options.dir)
  const cacheControl = options.cacheControl ?? 'no-cache'
  const spa = options.spa ?? false
  let realRoot: string | null = null

  app.on(['GET', 'HEAD'], '*', async (c) => {
    const path = c.req.path
    if (RESERVED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return notFound(c)
    }

    realRoot ??= await realpath(root).catch(() => null)
    if (!realRoot) return notFound(c)

    const file = await resolveFile(realRoot, path)
    if (file) return sendFile(c, file, cacheControl)

    if (spa && acceptsHtml(c.req.header('accept'))) {
      const index = await resolveFile(realRoot, '/')
      if (index) return sendFile(c, index, cacheControl)
    }

    return notFound(c)
  })
}

function notFound(c: Context<AppEnv>): Response {
  return c.json(
    { error: { code: 'not_found', message: 'Not found', request_id: c.get('requestId') } },
    404,
  )
}

function acceptsHtml(accept: string | undefined): boolean {
  // Only real navigations, not `fetch` defaults (`*/*`), so an unknown API-ish
  // path still gets JSON instead of the SPA shell.
  return Boolean(accept?.includes('text/html'))
}

async function resolveFile(realRoot: string, path: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const relative = decoded.replace(/^\/+/, '')
  const candidate = resolve(join(realRoot, relative))
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) return null

  const target = decoded.endsWith('/') ? join(candidate, 'index.html') : candidate
  const info = await stat(target).catch(() => null)

  if (info?.isFile()) {
    // Resolve symlinks only for files that exist, so a link inside the root
    // cannot expose anything outside it.
    return insideRoot(realRoot, target)
  }

  if (info?.isDirectory()) {
    return insideRoot(realRoot, join(target, 'index.html'))
  }

  return null
}

async function insideRoot(realRoot: string, file: string): Promise<string | null> {
  const realFile = await realpath(file).catch(() => null)
  if (!realFile || (realFile !== realRoot && !realFile.startsWith(realRoot + sep))) return null
  const info = await stat(realFile).catch(() => null)
  return info?.isFile() ? realFile : null
}

async function sendFile(
  c: Context<AppEnv>,
  file: string,
  cacheControl: string,
): Promise<Response> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return notFound(c)

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const headers = new Headers({
    'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    etag,
    'last-modified': info.mtime.toUTCString(),
  })

  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers })
  }

  if (c.req.method === 'HEAD') {
    headers.set('content-length', String(info.size))
    return new Response(null, { status: 200, headers })
  }

  const body = await readFile(file)
  headers.set('content-length', String(body.byteLength))
  return new Response(body, { status: 200, headers })
}

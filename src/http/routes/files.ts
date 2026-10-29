import { createHash, randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../../db/connect.js'
import type { Registry } from '../../tables/registry.js'
import type { Storage } from '../../storage/storage.js'
import { recordAudit } from '../../audit/log.js'
import { updateRow, viewRow } from '../../tables/crud.js'
import { badRequest, notFound } from '../errors.js'

export interface FileRoutesDeps {
  db: Db
  registry: Registry
  storage: Storage
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

export function registerFileRoutes(app: Hono<AppEnv>, deps: FileRoutesDeps): void {
  app.post('/api/v1/:table/:id/files/:field', async (c) => {
    const table = deps.registry.get(c.req.param('table'))
    if (!table) throw notFound(`Unknown table "${c.req.param('table')}"`)

    const field = table.fields.get(c.req.param('field'))
    if (!field || field.type !== 'file') {
      throw notFound(`Table "${table.name}" has no file field "${c.req.param('field')}"`)
    }

    const form = await c.req.parseBody()
    const file = form.file
    if (!isFile(file)) throw badRequest('Expected a multipart field named "file"')

    if (file.size > field.maxBytes) {
      throw badRequest(`File is larger than ${field.maxBytes} bytes`)
    }

    const contentType = file.type || 'application/octet-stream'
    if (field.allowedTypes.length && !field.allowedTypes.some((prefix) => contentType.startsWith(prefix))) {
      throw badRequest(`Content type "${contentType}" is not allowed for ${field.name}`)
    }

    const data = Buffer.from(await file.arrayBuffer())
    const key = buildKey(table.name, c.req.param('id'), field.name, file.name, contentType)

    await deps.storage.put(key, data, contentType, file.name)

    try {
      // The update rule is the authorization check. If it denies, the file is
      // removed again so a denied upload cannot fill the disk.
      const row = updateRow(deps.db, table, c.get('auth'), c.req.param('id'), {
        [field.name]: key,
      })

      recordAudit(deps.db, {
        event: 'file.upload',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: c.get('auth').uid,
        table: table.name,
        operation: 'update',
        resourceId: c.req.param('id'),
        metadata: { field: field.name, bytes: data.length, contentType },
      })

      return c.json({ field: field.name, key, row }, 201)
    } catch (error) {
      await deps.storage.delete(key)
      throw error
    }
  })

  app.get('/api/v1/:table/:id/files/:field', async (c) => {
    const table = deps.registry.get(c.req.param('table'))
    if (!table) throw notFound(`Unknown table "${c.req.param('table')}"`)

    const field = table.fields.get(c.req.param('field'))
    if (!field || field.type !== 'file') {
      throw notFound(`Table "${table.name}" has no file field "${c.req.param('field')}"`)
    }

    // The view rule decides whether the row (and therefore its file) exists.
    const row = viewRow(deps.db, table, c.get('auth'), c.req.param('id'))
    const key = row[field.name]
    if (typeof key !== 'string') throw notFound('No file for this field')

    const stored = await deps.storage.get(key)
    if (!stored) throw notFound('File not found')

    const body = new Uint8Array(stored.data)
    return c.body(body, 200, {
      'content-type': stored.contentType,
      'content-length': String(body.length),
      'content-disposition': `inline; filename="${safeFilename(stored.filename)}"`,
      'cache-control': 'private, max-age=60',
      // Uploads are user content. Sandbox stops an allowed SVG or HTML file
      // from running script on the API origin if opened directly.
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    })
  })
}

function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File
}

function buildKey(
  table: string,
  id: string,
  field: string,
  filename: string,
  contentType: string,
): string {
  const idHash = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)
  return `${table}/${idHash}/${field}/${randomUUID()}.${extensionFor(filename, contentType)}`
}

function extensionFor(filename: string, contentType: string): string {
  const fromName = filename.includes('.') ? filename.split('.').pop() : ''
  if (fromName && /^[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  return EXTENSIONS[contentType] ?? 'bin'
}

function safeFilename(filename: string): string {
  const cleaned = filename.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  return cleaned || 'file'
}

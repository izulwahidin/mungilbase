import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'
import { LocalStorage } from '../../src/storage/local.js'

let dir: string
let db: Db
let app: ReturnType<typeof createApp>
let rowId: string

const config = configSchema.parse({
  storage: { local: { dir: './data/unused-in-tests' } },
  tables: [
    {
      name: 'profiles',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'avatar', type: 'file', allowedTypes: ['image/'], maxBytes: 1_024 },
      ],
      rules: { list: 'true', view: 'true', create: 'true', update: 'true', delete: 'true' },
    },
  ],
})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mungil-upload-'))
  config.storage = { local: { dir } }

  db = openDatabase(':memory:')
  ensureSchema(db, createRegistry(config))
  ensureAuditSchema(db)
  app = createApp({ config, version: 'test', db, registry: createRegistry(config) })

  const created = await app.request('/api/v1/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada' }),
  })
  expect(created.status).toBe(201)
  rowId = ((await created.json()) as { id: string }).id
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function storedFiles(): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.meta.json'))
    .map((entry) => join(entry.parentPath ?? '', entry.name))
}

function upload(bytes: Uint8Array, type: string, filename: string, field = 'avatar'): Promise<Response> {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), filename)
  return Promise.resolve(
    app.request(`/api/v1/profiles/${rowId}/files/${field}`, { method: 'POST', body: form }),
  )
}

describe('file uploads', () => {
  it('stores an allowed file, updates the row and serves it back', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const response = await upload(bytes, 'image/png', 'pic.png')
    expect(response.status).toBe(201)

    const body = (await response.json()) as {
      field: string
      key: string
      row: { avatar: string }
    }
    expect(body.field).toBe('avatar')
    expect(body.key).toMatch(/^profiles\/[a-f0-9]{16}\/avatar\/[A-Za-z0-9_-]+\.png$/)
    expect(body.row.avatar).toBe(body.key)

    const served = await app.request(`/api/v1/profiles/${rowId}/files/avatar`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)
  })

  it('rejects disallowed types and oversized files without writing anything', async () => {
    expect((await upload(new Uint8Array([1]), 'text/plain', 'note.txt')).status).toBe(400)
    expect((await upload(new Uint8Array(2_048), 'image/png', 'big.png')).status).toBe(400)

    expect(storedFiles()).toHaveLength(1)
  })

  it('rejects fields that are not files and missing multipart files', async () => {
    const notFile = await upload(new Uint8Array([1]), 'image/png', 'x.png', 'name')
    expect(notFile.status).toBe(404)

    const empty = await app.request(`/api/v1/profiles/${rowId}/files/avatar`, {
      method: 'POST',
      body: new FormData(),
    })
    expect(empty.status).toBe(400)
  })

  it('removes the stored file when the update rule denies', async () => {
    const deniedConfig = configSchema.parse({
      storage: { local: { dir } },
      tables: [
        {
          name: 'profiles',
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'avatar', type: 'file', allowedTypes: ['image/'], maxBytes: 1_024 },
          ],
          rules: { list: 'true', view: 'true', create: 'true', update: 'false', delete: 'true' },
        },
      ],
    })
    const denied = createApp({
      config: deniedConfig,
      version: 'test',
      db,
      registry: createRegistry(deniedConfig),
    })

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([9])], { type: 'image/png' }), 'denied.png')
    const response = await denied.request(`/api/v1/profiles/${rowId}/files/avatar`, {
      method: 'POST',
      body: form,
    })
    expect(response.status).toBe(403)

    expect(storedFiles()).toHaveLength(1)
  })

  it('hides files when the view rule hides the row', async () => {
    const hiddenConfig = configSchema.parse({
      storage: { local: { dir } },
      tables: [
        {
          name: 'profiles',
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'avatar', type: 'file', allowedTypes: ['image/'], maxBytes: 1_024 },
          ],
          rules: { list: 'true', view: 'false', create: 'true', update: 'true', delete: 'true' },
        },
      ],
    })
    const hidden = createApp({
      config: hiddenConfig,
      version: 'test',
      db,
      registry: createRegistry(hiddenConfig),
    })

    const response = await hidden.request(`/api/v1/profiles/${rowId}/files/avatar`)
    expect(response.status).toBe(404)
  })

  it('deletes replaced and deleted files', async () => {
    const store = new LocalStorage(dir)
    const oldKey = (
      db.prepare(`SELECT "avatar" FROM "profiles" WHERE "id" = ?`).get(rowId) as { avatar: string }
    ).avatar
    expect(oldKey).toBeTruthy()

    const replacement = await upload(new Uint8Array([7, 7]), 'image/png', 'new.png')
    expect(replacement.status).toBe(201)
    const newKey = ((await replacement.json()) as { key: string }).key

    expect(await store.get(oldKey)).toBeNull()
    expect(await store.get(newKey)).not.toBeNull()

    const deleted = await app.request(`/api/v1/profiles/${rowId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await store.get(newKey)).toBeNull()
  })
})

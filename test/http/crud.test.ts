import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const denials = { list: null, view: null, create: null, update: null, delete: null }

const config = configSchema.parse({
  tables: [
    {
      name: 'users',
      fields: [{ name: 'email', type: 'text', required: true, unique: true }],
      rules: { ...denials, create: 'true' },
    },
    {
      name: 'posts',
      fields: [
        { name: 'author_id', type: 'text', required: true, references: { table: 'users', column: 'id' } },
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: false },
      ],
      rules: {
        list: 'published == true | auth.uid == author_id',
        view: 'published == true | auth.uid == author_id',
        create: 'auth.uid != null & author_id == auth.uid',
        update: 'auth.uid == author_id',
        delete: 'auth.uid == author_id',
      },
    },
  ],
})

const registry = createRegistry(config)
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(() => {
  db = openDatabase(':memory:')
  ensureSchema(db, registry)
  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u1', 'a@example.com')
  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u2', 'b@example.com')

  app = createApp({
    config,
    version: 'test',
    db,
    registry,
    auth: (c) => ({ uid: c.req.header('x-test-uid') ?? null }),
  })
})

afterAll(() => {
  db.close()
})

function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  }
}

async function createPost(uid: string | null, body: Record<string, unknown> = { title: 'Hello', author_id: 'u1' }) {
  return app.request('/api/v1/posts', json(body, { method: 'POST', headers: uid ? { 'x-test-uid': uid } : {} }))
}

describe('crud routes', () => {
  it('creates, reads, updates and deletes a row end to end', async () => {
    const created = await createPost('u1')
    expect(created.status).toBe(201)
    const row = (await created.json()) as Record<string, unknown>
    expect(row.title).toBe('Hello')
    expect(row.published).toBe(false)
    expect(typeof row.id).toBe('string')

    const id = String(row.id)
    const visible = await app.request(`/api/v1/posts/${id}`, { headers: { 'x-test-uid': 'u1' } })
    expect(visible.status).toBe(200)

    const hidden = await app.request(`/api/v1/posts/${id}`)
    expect(hidden.status).toBe(404)

    const list = await app.request('/api/v1/posts', { headers: { 'x-test-uid': 'u1' } })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1)

    const updated = await app.request(
      `/api/v1/posts/${id}`,
      json({ title: 'Updated', published: true }, { method: 'PATCH', headers: { 'x-test-uid': 'u1' } }),
    )
    expect(updated.status).toBe(200)
    const updatedRow = (await updated.json()) as Record<string, unknown>
    expect(updatedRow.title).toBe('Updated')
    expect(updatedRow.published).toBe(true)

    // Published now, so u2 can see it but not modify it.
    const denied = await app.request(
      `/api/v1/posts/${id}`,
      json({ title: 'Hijack' }, { method: 'PATCH', headers: { 'x-test-uid': 'u2' } }),
    )
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('rule_violation')

    const deleted = await app.request(`/api/v1/posts/${id}`, {
      method: 'DELETE',
      headers: { 'x-test-uid': 'u1' },
    })
    expect(deleted.status).toBe(200)
  })

  it('denies anonymous creates with a typed error envelope', async () => {
    const response = await createPost(null)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string; request_id: string } }
    expect(body.error.code).toBe('rule_violation')
    expect(body.error.request_id).toHaveLength(36)
  })

  it('rejects invalid input with field details', async () => {
    const response = await createPost('u1', { title: 'x', author_id: 'u1', nope: 1 })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.details).toEqual([{ field: 'nope', message: 'Unknown field' }])
  })

  it('returns 404 for unknown tables', async () => {
    const response = await app.request('/api/v1/ghosts')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('handles malformed and oversized bodies', async () => {
    const malformed = await app.request('/api/v1/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(malformed.status).toBe(400)

    const oversized = await app.request('/api/v1/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(1_000_001) }),
    })
    expect(oversized.status).toBe(400)
    expect(((await oversized.json()) as { error: { message: string } }).error.message).toMatch(/at most/)
  })

  it('supports filter, sort and pagination query params', async () => {
    await createPost('u1', { title: 'Alpha', author_id: 'u1', published: true })
    await createPost('u1', { title: 'Beta', author_id: 'u1', published: true })

    const response = await app.request('/api/v1/posts?filter=published%20%3D%3D%20true&sort=-title&limit=1')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: { title: string }[]; limit: number }
    expect(body.limit).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.title).toBe('Beta')

    const bad = await app.request('/api/v1/posts?sort=password_hash')
    expect(bad.status).toBe(400)
  })
})

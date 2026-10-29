import { beforeEach, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { anonymous, type AuthContext } from '../../src/auth/context.js'
import { AppError } from '../../src/http/errors.js'
import { createRegistry, type RegisteredTable } from '../../src/tables/registry.js'
import { createRow, deleteRow, listRows, updateRow, viewRow } from '../../src/tables/crud.js'

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
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
        { name: 'meta', type: 'json' },
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

const asA: AuthContext = { uid: 'u1' }
const asB: AuthContext = { uid: 'u2' }

let db: Db
let posts: RegisteredTable
let users: RegisteredTable

beforeEach(() => {
  db = openDatabase(':memory:')
  const registry = createRegistry(config)
  ensureSchema(db, registry)
  posts = registry.get('posts')!
  users = registry.get('users')!
  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u1', 'a@example.com')
  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u2', 'b@example.com')
})

function appError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Expected an AppError')
}

describe('createRow', () => {
  it('creates a row with id, timestamps and defaults', () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'Hello' })

    expect(typeof row.id).toBe('string')
    expect(row.title).toBe('Hello')
    expect(row.published).toBe(false)
    expect(row.body).toBeNull()
    expect(typeof row.created_at).toBe('string')
    expect(row.updated_at).toBe(row.created_at)
  })

  it('round-trips json fields as objects', () => {
    const row = createRow(db, posts, asA, {
      author_id: 'u1',
      title: 'With meta',
      meta: { tags: ['a', 'b'], nested: { ok: true } },
    })
    expect(row.meta).toEqual({ tags: ['a', 'b'], nested: { ok: true } })
  })

  it('denies anonymous creates with rule_violation', () => {
    const error = appError(() => createRow(db, posts, anonymous, { author_id: 'u1', title: 'Anon' }))
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe('rule_violation')
    expect(listRows(db, posts, asA).items).toHaveLength(0)
  })

  it('denies creating rows owned by someone else', () => {
    const error = appError(() => createRow(db, posts, asA, { author_id: 'u2', title: 'Nope' }))
    expect(error.code).toBe('rule_violation')
  })

  it('rejects unknown fields and missing required values', () => {
    const unknown = appError(() => createRow(db, posts, asA, { author_id: 'u1', title: 'x', publised: true }))
    expect(unknown.statusCode).toBe(400)
    expect(unknown.details).toEqual([{ field: 'publised', message: 'Unknown field' }])

    const missing = appError(() => createRow(db, posts, asA, { author_id: 'u1' }))
    expect(missing.statusCode).toBe(400)
    expect(missing.details).toEqual([{ field: 'title', message: 'Is required' }])
  })

  it('rejects wrong value types', () => {
    const error = appError(() => createRow(db, posts, asA, { author_id: 'u1', title: 42 }))
    expect(error.statusCode).toBe(400)
    expect(error.details).toEqual([{ field: 'title', message: 'Expected a string' }])
  })

  it('rejects null for a required field', () => {
    const error = appError(() => createRow(db, posts, asA, { author_id: null, title: 'x' }))
    expect(error.statusCode).toBe(400)
    expect(error.details).toEqual([{ field: 'author_id', message: 'Cannot be null' }])
  })

  it('maps unique violations to conflict', () => {
    createRow(db, users, anonymous, { email: 'dup@example.com' })
    const error = appError(() => createRow(db, users, anonymous, { email: 'dup@example.com' }))
    expect(error.statusCode).toBe(409)
    expect(error.code).toBe('conflict')
  })

  it('maps foreign key violations to bad_request', () => {
    const error = appError(() => createRow(db, posts, { uid: 'ghost' }, { author_id: 'ghost', title: 'x' }))
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe('bad_request')

    const rows = db.prepare(`SELECT COUNT(*) AS count FROM "posts"`).get() as { count: number }
    expect(rows.count).toBe(0)
  })

  it('never inserts a row when the rule denies, even with valid data', () => {
    appError(() => createRow(db, posts, asA, { author_id: 'u2', title: 'Nope' }))
    const rows = db.prepare(`SELECT COUNT(*) AS count FROM "posts"`).get() as { count: number }
    expect(rows.count).toBe(0)
  })
})

describe('read rules', () => {
  it('hides drafts from anonymous and other users', () => {
    const draft = createRow(db, posts, asA, { author_id: 'u1', title: 'Draft' })

    expect(listRows(db, posts, anonymous).items).toEqual([])
    expect(listRows(db, posts, asB).items).toEqual([])
    expect(listRows(db, posts, asA).items).toHaveLength(1)

    expect(appError(() => viewRow(db, posts, anonymous, String(draft.id))).code).toBe('not_found')
    expect(appError(() => viewRow(db, posts, asB, String(draft.id))).code).toBe('not_found')
    expect(viewRow(db, posts, asA, String(draft.id)).title).toBe('Draft')
  })

  it('shows published posts to everyone', () => {
    const post = createRow(db, posts, asA, { author_id: 'u1', title: 'Public' })
    updateRow(db, posts, asA, String(post.id), { published: true })

    expect(listRows(db, posts, anonymous).items).toHaveLength(1)
    expect(viewRow(db, posts, asB, String(post.id)).title).toBe('Public')
  })

  it('bypasses rules only when the admin flag is set', () => {
    const draft = createRow(db, posts, asA, { author_id: 'u1', title: 'Secret' })

    const roleOnly: AuthContext = { uid: 'u2', role: 'admin' }
    expect(listRows(db, posts, roleOnly).items).toHaveLength(0)
    expect(appError(() => viewRow(db, posts, roleOnly, String(draft.id))).code).toBe('not_found')

    const admin: AuthContext = { uid: 'u2', role: 'admin', admin: true }
    expect(listRows(db, posts, admin).items).toHaveLength(1)
    expect(viewRow(db, posts, admin, String(draft.id)).title).toBe('Secret')

    const created = createRow(db, posts, admin, { author_id: 'u1', title: 'On behalf' })
    expect(created.author_id).toBe('u1')
  })

  it('supports filter, sort and pagination', () => {
    createRow(db, posts, asA, { author_id: 'u1', title: 'Alpha', published: true })
    createRow(db, posts, asA, { author_id: 'u1', title: 'Beta', published: true })
    createRow(db, posts, asA, { author_id: 'u1', title: 'Gamma', published: true })

    // Newest first by default.
    expect(listRows(db, posts, anonymous).items.map((row) => row.title)).toEqual(['Gamma', 'Beta', 'Alpha'])

    const filtered = listRows(db, posts, anonymous, { filter: "title ~ 'a%' | title ~ 'B%'", sort: 'title' })
    expect(filtered.items.map((row) => row.title)).toEqual(['Alpha', 'Beta'])

    const sorted = listRows(db, posts, anonymous, { sort: '-title', limit: 2 })
    expect(sorted.items.map((row) => row.title)).toEqual(['Gamma', 'Beta'])

    const page = listRows(db, posts, anonymous, { sort: 'title', limit: 2, offset: 2 })
    expect(page.items.map((row) => row.title)).toEqual(['Gamma'])
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(2)
  })

  it('rejects bad query options', () => {
    expect(appError(() => listRows(db, posts, anonymous, { limit: 0 })).statusCode).toBe(400)
    expect(appError(() => listRows(db, posts, anonymous, { limit: 201 })).statusCode).toBe(400)
    expect(appError(() => listRows(db, posts, anonymous, { offset: -1 })).statusCode).toBe(400)
    expect(appError(() => listRows(db, posts, anonymous, { sort: 'nope' })).statusCode).toBe(400)
    expect(appError(() => listRows(db, posts, anonymous, { filter: 'nope == 1' })).statusCode).toBe(400)
    expect(appError(() => listRows(db, posts, anonymous, { filter: '1 == 1; DROP TABLE posts' })).statusCode).toBe(400)
  })
})

describe('updateRow', () => {
  it('updates own rows and refreshes updated_at', async () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'Old' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const updated = updateRow(db, posts, asA, String(row.id), { title: 'New' })
    expect(updated.title).toBe('New')
    expect(String(updated.updated_at) >= String(row.updated_at)).toBe(true)
  })

  it('denies updates by others with rule_violation when the row is visible', () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'Mine', published: true })
    const error = appError(() => updateRow(db, posts, asB, String(row.id), { title: 'Hijack' }))
    expect(error.code).toBe('rule_violation')
    expect(error.statusCode).toBe(403)
  })

  it('returns not_found for rows the user cannot see', () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'Private' })
    expect(appError(() => updateRow(db, posts, asB, String(row.id), { title: 'x' })).code).toBe('not_found')
    expect(appError(() => updateRow(db, posts, asB, 'missing', { title: 'x' })).code).toBe('not_found')
  })

  it('rejects empty and invalid patches', () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'x' })
    expect(appError(() => updateRow(db, posts, asA, String(row.id), {})).statusCode).toBe(400)
    expect(appError(() => updateRow(db, posts, asA, String(row.id), { id: 'other' })).statusCode).toBe(400)
  })
})

describe('deleteRow', () => {
  it('deletes own rows', () => {
    const row = createRow(db, posts, asA, { author_id: 'u1', title: 'Bye' })
    const deleted = deleteRow(db, posts, asA, String(row.id))
    expect(deleted.id).toBe(row.id)
    expect(appError(() => viewRow(db, posts, asA, String(row.id))).code).toBe('not_found')
  })

  it('denies deletes by others when visible, hides otherwise', () => {
    const publicPost = createRow(db, posts, asA, { author_id: 'u1', title: 'Public', published: true })
    expect(appError(() => deleteRow(db, posts, asB, String(publicPost.id))).code).toBe('rule_violation')

    const privatePost = createRow(db, posts, asA, { author_id: 'u1', title: 'Private' })
    expect(appError(() => deleteRow(db, posts, asB, String(privatePost.id))).code).toBe('not_found')
  })
})

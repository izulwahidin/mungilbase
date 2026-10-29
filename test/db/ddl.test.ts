import { describe, expect, it } from 'vitest'
import { configSchema, type MungilConfig } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema, tableDdl } from '../../src/db/ddl.js'
import { createRegistry } from '../../src/tables/registry.js'

const denyAll = { list: null, view: null, create: null, update: null, delete: null }

function configWith(postsFields: unknown[], extra: Record<string, unknown> = {}): MungilConfig {
  return configSchema.parse({
    tables: [
      {
        name: 'users',
        fields: [{ name: 'email', type: 'text', required: true, unique: true }],
        rules: denyAll,
      },
      {
        name: 'posts',
        fields: postsFields,
        rules: { ...denyAll, list: 'true' },
        ...extra,
      },
    ],
  })
}

const basePosts = [
  { name: 'author_id', type: 'text', required: true, references: { table: 'users', column: 'id' } },
  { name: 'title', type: 'text', required: true },
  { name: 'published', type: 'boolean', default: false },
  { name: 'meta', type: 'json' },
]

function sync(db: Db, config: MungilConfig) {
  return ensureSchema(db, createRegistry(config))
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name)
}

describe('tableDdl', () => {
  it('is deterministic and includes the implicit columns', () => {
    const config = configWith(basePosts)
    const posts = config.tables[1]!
    const ddl = tableDdl(posts)

    expect(ddl.create).toBe(tableDdl(posts).create)
    expect(ddl.create).toContain('"id" TEXT PRIMARY KEY NOT NULL')
    expect(ddl.create).toContain('"created_at" TEXT NOT NULL DEFAULT')
    expect(ddl.create).toContain('"updated_at" TEXT NOT NULL DEFAULT')
    expect(ddl.create).toContain('"author_id" TEXT NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT')
    expect(ddl.create).toContain('"published" INTEGER DEFAULT 0 CHECK ("published" IN (0, 1))')
    expect(ddl.create).toContain('CHECK ("meta" IS NULL OR json_valid("meta"))')
    expect(ddl.indexes).toEqual([
      'CREATE INDEX IF NOT EXISTS "idx_posts_author_id" ON "posts" ("author_id")',
      'CREATE INDEX IF NOT EXISTS "idx_posts_created_at" ON "posts" ("created_at")',
    ])
  })

  it('escapes default values', () => {
    const config = configWith([{ name: 'title', type: 'text', default: "it's" }])
    expect(tableDdl(config.tables[1]!).create).toContain(`DEFAULT 'it''s'`)
  })
})

describe('ensureSchema', () => {
  it('creates tables and indexes once', () => {
    const db = openDatabase(':memory:')
    const config = configWith(basePosts)

    expect(sync(db, config)).toEqual({ created: ['users', 'posts'], altered: [] })
    expect(sync(db, config)).toEqual({ created: [], altered: [] })

    expect(columns(db, 'posts')).toEqual(['id', 'author_id', 'title', 'published', 'meta', 'created_at', 'updated_at'])
    expect(columns(db, 'users')).toEqual(['id', 'email', 'created_at', 'updated_at'])

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posts'`)
      .all() as { name: string }[]
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['idx_posts_author_id', 'idx_posts_created_at']),
    )
    db.close()
  })

  it('backfills indexes for tables created by an older version', () => {
    const db = openDatabase(':memory:')
    sync(db, configWith(basePosts))
    db.exec(`DROP INDEX "idx_posts_created_at"`)

    expect(sync(db, configWith(basePosts))).toEqual({ created: [], altered: [] })
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posts'`)
      .all() as { name: string }[]
    expect(indexes.map((index) => index.name)).toContain('idx_posts_created_at')
    db.close()
  })

  it('adds a nullable column in place', () => {
    const db = openDatabase(':memory:')
    sync(db, configWith(basePosts))

    const result = sync(db, configWith([...basePosts, { name: 'subtitle', type: 'text' }]))
    expect(result).toEqual({ created: [], altered: [{ table: 'posts', columns: ['subtitle'] }] })
    expect(columns(db, 'posts')).toContain('subtitle')
    db.close()
  })

  it('adds a required column when it has a default', () => {
    const db = openDatabase(':memory:')
    sync(db, configWith(basePosts))
    db.prepare(`INSERT INTO "users" ("id", "email") VALUES ('u1', 'a@example.com')`).run()
    db.prepare(`INSERT INTO "posts" ("id", "author_id", "title") VALUES ('p1', 'u1', 'old')`).run()

    const result = sync(
      db,
      configWith([...basePosts, { name: 'published_at', type: 'text', required: true, default: 'draft' }]),
    )
    expect(result.altered).toEqual([{ table: 'posts', columns: ['published_at'] }])
    const row = db.prepare(`SELECT "published_at" FROM "posts" WHERE "id" = 'p1'`).get() as { published_at: string }
    expect(row.published_at).toBe('draft')
    db.close()
  })

  it('refuses destructive or ambiguous changes', () => {
    const db = openDatabase(':memory:')
    sync(db, configWith(basePosts))

    // Dropping a column from the config
    expect(() => sync(db, configWith(basePosts.slice(0, 3)))).toThrow(/not in the config/)

    // Adding a required column with no default
    expect(() => sync(db, configWith([...basePosts, { name: 'slug', type: 'text', required: true }]))).toThrow(
      /without a default/,
    )

    // Adding a unique column
    expect(() => sync(db, configWith([...basePosts, { name: 'slug', type: 'text', unique: true }]))).toThrow(
      /unique column/,
    )

    // Changing a column type
    const retyped = basePosts.map((field) =>
      field.name === 'title' ? { ...field, type: 'integer' } : field,
    )
    expect(() => sync(db, configWith(retyped))).toThrow(/Write a migration to change its type/)
    db.close()
  })

  it('refuses to silently drop timestamp columns', () => {
    const db = openDatabase(':memory:')
    sync(db, configWith(basePosts))
    expect(() => sync(db, configWith(basePosts, { timestamps: false }))).toThrow(/created_at/)
    db.close()
  })
})

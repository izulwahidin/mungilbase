import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { createRegistry, type RegisteredTable } from '../../src/tables/registry.js'
import { createRow, deleteRow, updateRow } from '../../src/tables/crud.js'
import {
  cleanupReplacedFiles,
  deleteStoredFiles,
  fileKeysForRow,
  fileKeysInRow,
} from '../../src/tables/files.js'
import { LocalStorage } from '../../src/storage/local.js'
import { collectReferencedKeys, runFileGc } from '../../src/storage/gc.js'

const config = configSchema.parse({
  tables: [
    {
      name: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'avatar', type: 'file', allowedTypes: ['image/'] },
      ],
      rules: { list: 'true', view: 'true', create: 'true', update: 'true', delete: 'true' },
    },
  ],
})

function keyFor(name: string): string {
  return `posts/0123456789abcdef/avatar/${randomUUID()}.${name}`
}

let dir: string
let db: Db
let storage: LocalStorage
let table: RegisteredTable

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mungil-gc-'))
  storage = new LocalStorage(dir)
  db = openDatabase(':memory:')
  const registry = createRegistry(config)
  ensureSchema(db, registry)
  table = registry.get('posts')!
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('file cleanup', () => {
  it('finds and deletes only unreferenced objects', async () => {
    const referencedKey = keyFor('png')
    const orphanKey = keyFor('png')

    await storage.put(referencedKey, Buffer.from('a'), 'image/png', 'a.png')
    await storage.put(orphanKey, Buffer.from('b'), 'image/png', 'b.png')

    createRow(db, table, { uid: null }, { title: 'A', avatar: referencedKey })

    expect(collectReferencedKeys(db, createRegistry(config)).has(referencedKey)).toBe(true)

    const dry = await runFileGc(db, createRegistry(config), storage, { apply: false })
    expect(dry).toEqual({ scanned: 2, referenced: 1, orphans: 1, deleted: 0 })
    expect(await storage.get(orphanKey)).not.toBeNull()

    const applied = await runFileGc(db, createRegistry(config), storage, { apply: true })
    expect(applied.deleted).toBe(1)
    expect(await storage.get(orphanKey)).toBeNull()
    expect(await storage.get(referencedKey)).not.toBeNull()
  })

  it('returns keys before a delete and removes them afterwards', async () => {
    const key = keyFor('png')
    await storage.put(key, Buffer.from('a'), 'image/png', 'a.png')
    const row = createRow(db, table, { uid: null }, { title: 'A', avatar: key })

    expect(fileKeysForRow(db, table, String(row.id))).toEqual([key])

    const deleted = deleteRow(db, table, { uid: null }, String(row.id))
    await deleteStoredFiles(storage, fileKeysInRow(table, deleted))

    expect(await storage.get(key)).toBeNull()
  })

  it('removes the previous key when a row is updated', async () => {
    const first = keyFor('png')
    const second = keyFor('png')
    await storage.put(first, Buffer.from('a'), 'image/png', 'a.png')
    await storage.put(second, Buffer.from('b'), 'image/png', 'b.png')

    const row = createRow(db, table, { uid: null }, { title: 'A', avatar: first })
    const previous = fileKeysForRow(db, table, String(row.id))
    const updated = updateRow(db, table, { uid: null }, String(row.id), { avatar: second })
    await cleanupReplacedFiles(storage, table, previous, updated)

    expect(await storage.get(first)).toBeNull()
    expect(await storage.get(second)).not.toBeNull()
  })
})

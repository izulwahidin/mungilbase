import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupDatabase } from '../../src/db/backup.js'
import { openDatabase, type Db } from '../../src/db/connect.js'

let dir: string
let source: Db
let sourcePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mungil-backup-'))
  sourcePath = join(dir, 'source.db')
  source = openDatabase(sourcePath)
  source.exec(`
    CREATE TABLE "notes" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "title" TEXT NOT NULL
    );
    INSERT INTO "notes" ("id", "title") VALUES ('a', 'first'), ('b', 'second');
  `)
})

afterEach(() => {
  source.close()
  rmSync(dir, { recursive: true, force: true })
})

function titles(path: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare(`SELECT "title" FROM "notes" ORDER BY "id"`).all() as { title: string }[]).map(
      (row) => row.title,
    )
  } finally {
    db.close()
  }
}

describe('backupDatabase', () => {
  it('creates a verified point-in-time copy of a live database', async () => {
    const target = join(dir, 'nested', 'snapshot.db')
    const result = await backupDatabase(source, target)

    expect(result.integrity).toBe('ok')
    expect(result.foreignKeyViolations).toBe(0)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.path).toBe(target)
    expect(titles(target)).toEqual(['first', 'second'])
  })

  it('does not freeze the source', async () => {
    await backupDatabase(source, join(dir, 'snapshot.db'))

    source.prepare(`INSERT INTO "notes" ("id", "title") VALUES ('c', 'after')`).run()
    expect(titles(sourcePath)).toEqual(['first', 'second', 'after'])
  })

  it('is a snapshot, not a mirror', async () => {
    const target = join(dir, 'snapshot.db')
    await backupDatabase(source, target)

    source.prepare(`INSERT INTO "notes" ("id", "title") VALUES ('c', 'after')`).run()
    expect(titles(target)).toEqual(['first', 'second'])
  })

  it('overwrites an older snapshot at the same path', async () => {
    const target = join(dir, 'snapshot.db')
    await backupDatabase(source, target)

    source.prepare(`UPDATE "notes" SET "title" = 'changed' WHERE "id" = 'a'`).run()
    const second = await backupDatabase(source, target)

    expect(second.integrity).toBe('ok')
    expect(titles(target)).toEqual(['changed', 'second'])
  })
})

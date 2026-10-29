import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/db/connect.js'
import { applyMigrations, MigrationError, MIGRATIONS_TABLE, type Migration } from '../../src/db/migrator.js'

function freshDb() {
  return openDatabase(':memory:')
}

const initial: Migration[] = [
  {
    id: '0001_initial',
    up: 'CREATE TABLE "notes" ("id" TEXT PRIMARY KEY NOT NULL, "title" TEXT NOT NULL)',
  },
]

function tableExists(db: ReturnType<typeof freshDb>, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return row !== undefined
}

describe('applyMigrations', () => {
  it('applies pending migrations once', () => {
    const db = freshDb()
    expect(applyMigrations(db, initial)).toEqual({ applied: ['0001_initial'] })
    expect(applyMigrations(db, initial)).toEqual({ applied: [] })
    expect(tableExists(db, 'notes')).toBe(true)
    expect(tableExists(db, MIGRATIONS_TABLE)).toBe(true)
    db.close()
  })

  it('records a checksum and refuses edits to applied migrations', () => {
    const db = freshDb()
    applyMigrations(db, initial)

    const edited: Migration[] = [{ ...initial[0]!, up: 'CREATE TABLE "notes" ("id" TEXT PRIMARY KEY)' }]
    expect(() => applyMigrations(db, edited)).toThrow(MigrationError)
    db.close()
  })

  it('refuses a database with migrations missing from the code', () => {
    const db = freshDb()
    applyMigrations(db, initial)
    expect(() => applyMigrations(db, [])).toThrow(/not present in the codebase/)
    db.close()
  })

  it('rolls back a failing migration completely', () => {
    const db = freshDb()
    const broken: Migration[] = [
      {
        id: '0001_broken',
        up: 'CREATE TABLE "kept" ("id" INTEGER); INSERT INTO "missing_table" VALUES (1);',
      },
    ]

    expect(() => applyMigrations(db, broken)).toThrow(/missing_table/)
    expect(tableExists(db, 'kept')).toBe(false)

    const rows = db.prepare(`SELECT COUNT(*) AS count FROM "${MIGRATIONS_TABLE}"`).get() as { count: number }
    expect(rows.count).toBe(0)
    db.close()
  })

  it('applies migrations that follow the failing one after it is fixed', () => {
    const db = freshDb()
    const broken: Migration[] = [{ id: '0001_broken', up: 'CREATE TABLE "nope" ("x" INTEGER' }]
    expect(() => applyMigrations(db, broken)).toThrow()

    const fixed: Migration[] = [
      { id: '0001_first', up: 'CREATE TABLE "a" ("x" INTEGER)' },
      { id: '0002_second', up: 'CREATE TABLE "b" ("x" INTEGER)' },
    ]
    expect(applyMigrations(db, fixed).applied).toEqual(['0001_first', '0002_second'])
    db.close()
  })

  it('rejects unsorted, duplicate and malformed ids', () => {
    const db = freshDb()
    expect(() => applyMigrations(db, [initial[0]!, { id: '0000_earlier', up: 'SELECT 1' }])).toThrow(/id order/)
    expect(() =>
      applyMigrations(db, [
        { id: '0001_a', up: 'SELECT 1' },
        { id: '0001_a', up: 'SELECT 1' },
      ]),
    ).toThrow(/Duplicate/)
    expect(() => applyMigrations(db, [{ id: 'initial', up: 'SELECT 1' }])).toThrow(/Invalid migration id/)
    db.close()
  })
})

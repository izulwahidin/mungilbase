import { createHash } from 'node:crypto'
import type { Db } from './connect.js'

export interface Migration {
  /** Stable, sortable id, e.g. `0001_initial`. Never reuse an id. */
  id: string
  up: string
  /** Optional. Never executed automatically; used by the documented rollback path. */
  down?: string
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError'
}

export const MIGRATIONS_TABLE = '_mungil_migrations'

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

interface AppliedRow {
  id: string
  checksum: string
}

/**
 * Applies pending migrations in one transaction each.
 *
 * Guarantees, all enforced by tests:
 * - a migration is applied at most once;
 * - editing an already-applied migration is a startup error, not a surprise;
 * - a database containing a migration the code no longer knows about is refused;
 * - a failing migration leaves the database exactly as it was.
 *
 * Migrations must not contain their own BEGIN/COMMIT: the runner owns the
 * transaction.
 */
export function applyMigrations(db: Db, migrations: readonly Migration[]): { applied: string[] } {
  assertOrdered(migrations)

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "applied_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  const rows = db.prepare(`SELECT "id", "checksum" FROM "${MIGRATIONS_TABLE}" ORDER BY "id"`).all() as AppliedRow[]
  const appliedById = new Map(rows.map((row) => [row.id, row.checksum]))
  const knownIds = new Set(migrations.map((migration) => migration.id))

  for (const row of rows) {
    if (!knownIds.has(row.id)) {
      throw new MigrationError(
        `Database has migration "${row.id}" that is not present in the codebase. ` +
          `Restore the migration file or restore the database from a backup.`,
      )
    }
  }

  const insert = db.prepare(`INSERT INTO "${MIGRATIONS_TABLE}" ("id", "checksum") VALUES (?, ?)`)
  const applied: string[] = []

  for (const migration of migrations) {
    const sum = checksum(migration.up)
    const previous = appliedById.get(migration.id)

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new MigrationError(
          `Migration "${migration.id}" changed after it was applied (checksum mismatch). ` +
            `Add a new migration instead of editing an applied one.`,
        )
      }
      continue
    }

    db.transaction(() => {
      db.exec(migration.up)
      insert.run(migration.id, sum)
    }).immediate()

    applied.push(migration.id)
  }

  return { applied }
}

function assertOrdered(migrations: readonly Migration[]): void {
  const seen = new Set<string>()
  let previous = ''
  for (const migration of migrations) {
    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(migration.id)) {
      throw new MigrationError(`Invalid migration id "${migration.id}". Expected e.g. "0001_initial".`)
    }
    if (seen.has(migration.id)) {
      throw new MigrationError(`Duplicate migration id "${migration.id}"`)
    }
    if (migration.id <= previous) {
      throw new MigrationError(`Migrations must be declared in id order; "${migration.id}" came after "${previous}"`)
    }
    seen.add(migration.id)
    previous = migration.id
  }
}

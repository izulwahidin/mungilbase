import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Db } from './connect.js'

export interface BackupResult {
  path: string
  bytes: number
  integrity: string
  foreignKeyViolations: number
}

/**
 * Consistent snapshot of a live database using SQLite's online backup API.
 *
 * Safe while the server is running: the copy is a point-in-time image, not a
 * file copy that can catch a half-written WAL frame. The snapshot is verified
 * immediately, because an unverified backup is just a file.
 */
export async function backupDatabase(db: Db, destination: string): Promise<BackupResult> {
  mkdirSync(dirname(destination), { recursive: true })
  await db.backup(destination)

  const copy = new Database(destination, { readonly: true })
  try {
    const integrityRow = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    const integrity = integrityRow.integrity_check
    if (integrity !== 'ok') {
      throw new Error(`Backup integrity check failed: ${integrity}`)
    }

    const foreignKeyViolations = copy.prepare('PRAGMA foreign_key_check').all().length
    if (foreignKeyViolations > 0) {
      throw new Error(`Backup has ${foreignKeyViolations} foreign key violation(s)`)
    }

    return {
      path: destination,
      bytes: statSync(destination).size,
      integrity,
      foreignKeyViolations,
    }
  } finally {
    copy.close()
  }
}

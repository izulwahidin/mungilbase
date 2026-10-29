import type { Db } from '../db/connect.js'
import { quote } from '../db/ddl.js'
import type { Registry } from '../tables/registry.js'
import type { Storage } from './storage.js'

export interface FileGcResult {
  scanned: number
  referenced: number
  orphans: number
  deleted: number
}

/**
 * Every key referenced by a file field in any config table.
 * Missing tables are skipped: GC may run before a schema sync.
 */
export function collectReferencedKeys(db: Db, registry: Registry): Set<string> {
  const referenced = new Set<string>()

  for (const table of registry.tables.values()) {
    const fields = table.config.fields.filter((field) => field.type === 'file')
    for (const field of fields) {
      try {
        const rows = db
          .prepare(
            `SELECT ${quote(field.name)} AS "key" FROM ${quote(table.name)}
             WHERE ${quote(field.name)} IS NOT NULL`,
          )
          .all() as { key: unknown }[]

        for (const row of rows) {
          if (typeof row.key === 'string' && row.key.length > 0) referenced.add(row.key)
        }
      } catch {
        // Table does not exist yet.
      }
    }
  }

  return referenced
}

/**
 * Deletes stored objects no row points at. Dry-run unless `apply` is true.
 */
export async function runFileGc(
  db: Db,
  registry: Registry,
  storage: Storage,
  options: { apply: boolean },
): Promise<FileGcResult> {
  const referenced = collectReferencedKeys(db, registry)
  const keys = await storage.list()
  const orphans = keys.filter((key) => !referenced.has(key))

  let deleted = 0
  if (options.apply) {
    for (const key of orphans) {
      await storage.delete(key)
      deleted += 1
    }
  }

  return {
    scanned: keys.length,
    referenced: referenced.size,
    orphans: orphans.length,
    deleted,
  }
}

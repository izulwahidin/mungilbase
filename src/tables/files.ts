import type { Db } from '../db/connect.js'
import { quote } from '../db/ddl.js'
import type { Storage } from '../storage/storage.js'
import type { RegisteredTable } from './registry.js'

function fileFields(table: RegisteredTable) {
  return table.config.fields.filter((field) => field.type === 'file')
}

export function fileKeysInRow(table: RegisteredTable, row: Record<string, unknown>): string[] {
  const keys: string[] = []
  for (const field of fileFields(table)) {
    const value = row[field.name]
    if (typeof value === 'string' && value.length > 0) keys.push(value)
  }
  return keys
}

/** Reads the current file keys for a row directly, before a delete/update. */
export function fileKeysForRow(db: Db, table: RegisteredTable, id: string): string[] {
  const fields = fileFields(table)
  if (!fields.length) return []

  const row = db
    .prepare(
      `SELECT ${fields.map((field) => quote(field.name)).join(', ')}
       FROM ${quote(table.name)} WHERE ${quote('id')} = ?`,
    )
    .get(id) as Record<string, unknown> | undefined

  return row ? fileKeysInRow(table, row) : []
}

/**
 * Best-effort deletion. A storage failure is logged but never fails the
 * database operation: the row is already gone, and `files:gc` can collect
 * whatever is left.
 */
export async function deleteStoredFiles(storage: Storage, keys: readonly string[]): Promise<void> {
  for (const key of new Set(keys)) {
    try {
      await storage.delete(key)
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'file_delete_failed',
          key,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}

/** Deletes keys that the updated row no longer references. */
export async function cleanupReplacedFiles(
  storage: Storage,
  table: RegisteredTable,
  previousKeys: readonly string[],
  updatedRow: Record<string, unknown>,
): Promise<void> {
  const current = new Set(fileKeysInRow(table, updatedRow))
  await deleteStoredFiles(
    storage,
    previousKeys.filter((key) => !current.has(key)),
  )
}

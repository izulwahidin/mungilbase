import type { Db } from './connect.js'

/**
 * Runs `fn` in an immediate transaction. better-sqlite3 uses savepoints for
 * nested calls, so this composes.
 *
 * `IMMEDIATE` acquires the write lock up front, which avoids the upgrade
 * deadlock that `DEFERRED` can produce when two readers both try to write.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate()
}

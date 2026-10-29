import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

export interface OpenDatabaseOptions {
  /** Milliseconds a write may wait for a lock before SQLITE_BUSY. */
  busyTimeoutMs?: number
}

/**
 * Opens SQLite in the configuration we expect in production:
 * WAL, foreign keys enforced, a bounded busy timeout, synchronous=NORMAL.
 *
 * `synchronous=NORMAL` in WAL mode can lose the last transactions on power
 * loss but cannot corrupt the database. That is the standard trade for a
 * web service, and Litestream covers the durability gap.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Db {
  const absolutePath = file === ':memory:' ? file : resolve(file)
  if (absolutePath !== ':memory:') {
    mkdirSync(dirname(absolutePath), { recursive: true })
  }

  const db = new Database(absolutePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  db.pragma('synchronous = NORMAL')
  return db
}

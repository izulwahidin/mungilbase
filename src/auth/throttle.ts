import type { Db } from '../db/connect.js'
import { tooManyRequests } from '../http/errors.js'
import { AUTH_TABLES } from './schema.js'

export interface ThrottleRule {
  maxAttempts: number
  windowSeconds: number
}

interface ThrottleRow {
  window_start: number
  count: number
}

/**
 * Fixed-window counter. Increments before the check's caller does any work,
 * so concurrent attempts cannot share one free slot.
 *
 * The counter lives in SQLite, not memory: a restart must not reset a
 * brute-force budget. Single process means no locking is needed beyond the
 * synchronous statements.
 */
export function checkThrottle(db: Db, key: string, rule: ThrottleRule, nowMs = Date.now()): void {
  const nowSeconds = Math.floor(nowMs / 1000)
  const row = db
    .prepare(`SELECT "window_start", "count" FROM "${AUTH_TABLES.throttle}" WHERE "key" = ?`)
    .get(key) as ThrottleRow | undefined

  if (!row || nowSeconds - row.window_start >= rule.windowSeconds) {
    db.prepare(
      `INSERT INTO "${AUTH_TABLES.throttle}" ("key", "window_start", "count") VALUES (?, ?, 1)
       ON CONFLICT("key") DO UPDATE SET "window_start" = excluded."window_start", "count" = 1`,
    ).run(key, nowSeconds)
    return
  }

  if (row.count >= rule.maxAttempts) {
    throw tooManyRequests(Math.max(1, rule.windowSeconds - (nowSeconds - row.window_start)))
  }

  db.prepare(`UPDATE "${AUTH_TABLES.throttle}" SET "count" = "count" + 1 WHERE "key" = ?`).run(key)
}

export function clearThrottle(db: Db, key: string): void {
  db.prepare(`DELETE FROM "${AUTH_TABLES.throttle}" WHERE "key" = ?`).run(key)
}

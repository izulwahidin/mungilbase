import type { Db } from '../db/connect.js'

export const AUTH_TABLES = {
  users: '_mungil_auth_users',
  sessions: '_mungil_auth_sessions',
  tokens: '_mungil_auth_tokens',
  resets: '_mungil_auth_password_resets',
  throttle: '_mungil_rate_limits',
} as const

/**
 * Internal auth tables. They are not part of the user's config and are never
 * exposed through the CRUD routes (all route names are validated, and no
 * internal name matches).
 */
export function ensureAuthSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${AUTH_TABLES.users}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "email" TEXT NOT NULL UNIQUE,
      "password_hash" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'user' CHECK ("role" IN ('user', 'admin')),
      "created_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "${AUTH_TABLES.sessions}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "family_id" TEXT NOT NULL,
      "user_id" TEXT NOT NULL REFERENCES "${AUTH_TABLES.users}" ("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "last_seen_at" TEXT NOT NULL,
      "expires_at" TEXT NOT NULL,
      "revoked_at" TEXT
    );

    CREATE INDEX IF NOT EXISTS "idx_mungil_sessions_family" ON "${AUTH_TABLES.sessions}" ("family_id");
    CREATE INDEX IF NOT EXISTS "idx_mungil_sessions_user" ON "${AUTH_TABLES.sessions}" ("user_id");

    CREATE TABLE IF NOT EXISTS "${AUTH_TABLES.tokens}" (
      "token_hash" TEXT PRIMARY KEY NOT NULL,
      "session_id" TEXT NOT NULL REFERENCES "${AUTH_TABLES.sessions}" ("id") ON DELETE CASCADE,
      "kind" TEXT NOT NULL CHECK ("kind" IN ('access', 'refresh')),
      "created_at" TEXT NOT NULL,
      "expires_at" TEXT NOT NULL,
      "used_at" TEXT
    );

    CREATE INDEX IF NOT EXISTS "idx_mungil_tokens_session" ON "${AUTH_TABLES.tokens}" ("session_id");

    CREATE TABLE IF NOT EXISTS "${AUTH_TABLES.resets}" (
      "token_hash" TEXT PRIMARY KEY NOT NULL,
      "user_id" TEXT NOT NULL REFERENCES "${AUTH_TABLES.users}" ("id") ON DELETE CASCADE,
      "created_at" TEXT NOT NULL,
      "expires_at" TEXT NOT NULL,
      "used_at" TEXT
    );

    CREATE INDEX IF NOT EXISTS "idx_mungil_resets_user" ON "${AUTH_TABLES.resets}" ("user_id");

    CREATE TABLE IF NOT EXISTS "${AUTH_TABLES.throttle}" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "window_start" INTEGER NOT NULL,
      "count" INTEGER NOT NULL
    );
  `)

  // 0.1.x databases predate roles. Additive, like table schema sync.
  const userColumns = db.prepare(`PRAGMA table_info("${AUTH_TABLES.users}")`).all() as {
    name: string
  }[]
  if (!userColumns.some((column) => column.name === 'role')) {
    db.exec(
      `ALTER TABLE "${AUTH_TABLES.users}"
       ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user' CHECK ("role" IN ('user', 'admin'))`,
    )
  }
}

/**
 * Removes expired tokens, expired sessions and revoked sessions.
 * Safe to call at boot and periodically.
 */
export function cleanupAuth(db: Db, nowIso = new Date().toISOString()): void {
  db.prepare(
    `DELETE FROM "${AUTH_TABLES.resets}" WHERE "used_at" IS NOT NULL OR "expires_at" <= ?`,
  ).run(nowIso)
  db.prepare(`DELETE FROM "${AUTH_TABLES.tokens}" WHERE "expires_at" <= ?`).run(nowIso)
  db.prepare(
    `DELETE FROM "${AUTH_TABLES.sessions}" WHERE "expires_at" <= ? OR "revoked_at" IS NOT NULL`,
  ).run(nowIso)
  const nowSeconds = Math.floor(Date.parse(nowIso) / 1000)
  db.prepare(`DELETE FROM "${AUTH_TABLES.throttle}" WHERE "window_start" < ?`).run(
    nowSeconds - 7 * 24 * 60 * 60,
  )
}

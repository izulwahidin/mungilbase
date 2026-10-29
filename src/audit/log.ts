import type { Db } from '../db/connect.js'

export type AuditOutcome = 'success' | 'denied' | 'failure'

export interface AuditEntry {
  event: string
  outcome: AuditOutcome
  requestId?: string | null
  userId?: string | null
  table?: string | null
  operation?: string | null
  resourceId?: string | null
  code?: string | null
  metadata?: Record<string, unknown> | null
}

export const AUDIT_TABLE = '_mungil_audit'

/**
 * Append-only. No update or delete path exists in the application, so the
 * only way a row disappears is a DB restore or direct operator access.
 */
export function ensureAuditSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${AUDIT_TABLE}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "created_at" TEXT NOT NULL,
      "request_id" TEXT,
      "user_id" TEXT,
      "event" TEXT NOT NULL,
      "table_name" TEXT,
      "operation" TEXT,
      "resource_id" TEXT,
      "outcome" TEXT NOT NULL CHECK ("outcome" IN ('success', 'denied', 'failure')),
      "code" TEXT,
      "metadata" TEXT
    );

    CREATE INDEX IF NOT EXISTS "idx_mungil_audit_created" ON "${AUDIT_TABLE}" ("created_at");
    CREATE INDEX IF NOT EXISTS "idx_mungil_audit_user" ON "${AUDIT_TABLE}" ("user_id");
    CREATE INDEX IF NOT EXISTS "idx_mungil_audit_event" ON "${AUDIT_TABLE}" ("event");
  `)
}

/**
 * Writes an audit row. Never throws: losing an audit row must not turn a
 * user-facing 403 into a 500, and the failure itself is logged to stderr.
 */
export function recordAudit(db: Db, entry: AuditEntry, now = new Date()): void {
  try {
    db.prepare(
      `INSERT INTO "${AUDIT_TABLE}"
         ("created_at", "request_id", "user_id", "event", "table_name", "operation",
          "resource_id", "outcome", "code", "metadata")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now.toISOString(),
      entry.requestId ?? null,
      entry.userId ?? null,
      entry.event,
      entry.table ?? null,
      entry.operation ?? null,
      entry.resourceId ?? null,
      entry.outcome,
      entry.code ?? null,
      entry.metadata === undefined || entry.metadata === null ? null : JSON.stringify(entry.metadata),
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'audit_write_failed',
        auditEvent: entry.event,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { authConfigSchema, type MungilConfig } from '../config/schema.js'
import { AuthService } from '../auth/service.js'
import type { AuthRole } from '../auth/roles.js'
import { recordAudit, AUDIT_TABLE, ensureAuditSchema } from '../audit/log.js'
import { applyMigrations, MIGRATIONS_TABLE } from '../db/migrator.js'
import { migrations } from '../db/migrations.js'
import { ensureSchema } from '../db/ddl.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { backupDatabase } from '../db/backup.js'
import { createStorage } from '../storage/storage.js'
import { runFileGc } from '../storage/gc.js'
import { generateSdk } from '../sdk/generate.js'
import { AppError, badRequest, notFound } from '../http/errors.js'
import type { Db } from '../db/connect.js'
import type { Registry } from '../tables/registry.js'

export interface AdminIdentity {
  id: string
  email: string
  role: AuthRole
  emailVerified: boolean
}

export interface AdminToolsDeps {
  config: MungilConfig
  registry: Registry
  db: Db
  identity: AdminIdentity | null
  configPath: string | null
  dbFile: string
  version: string
  allowRawSql: boolean
}

const MUTATING = { readOnlyHint: false, openWorldHint: false } as const
const DESTRUCTIVE = { ...MUTATING, destructiveHint: true } as const
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

/**
 * Operator tools, modelled on the Supabase MCP surface: schema sync, account
 * management, backups, audit reads and (with a second opt-in) raw SQL.
 *
 * This is deliberately gated behind `--admin` plus an account whose role is
 * `admin`. The agent cannot promote itself: role checks happen here, not in
 * tool arguments.
 */
export function registerAdminTools(server: McpServer, deps: AdminToolsDeps): void {
  if (!deps.identity || deps.identity.role !== 'admin') {
    throw new Error('Admin MCP tools require an identity with the admin role.')
  }

  const { registry, db, config, identity } = deps
  const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))

  const audit = (
    event: string,
    outcome: 'success' | 'denied' | 'failure',
    options: { resourceId?: string | null; code?: string | null; metadata?: Record<string, unknown> } = {},
  ): void => {
    recordAudit(db, {
      event,
      outcome,
      userId: identity.id,
      operation: 'admin',
      resourceId: options.resourceId ?? null,
      code: options.code ?? null,
      metadata: { via: 'mcp', ...options.metadata },
    })
  }

  const audited = async <T>(
    event: string,
    run: () => Promise<T> | T,
    metadata?: Record<string, unknown>,
  ): Promise<T> => {
    try {
      const result = await run()
      audit(event, 'success', { metadata })
      return result
    } catch (error) {
      audit(event, error instanceof AppError && error.statusCode < 500 ? 'denied' : 'failure', {
        code: error instanceof AppError ? error.code : 'internal',
        metadata,
      })
      throw error
    }
  }

  server.registerTool(
    'get_config',
    {
      title: 'Get config',
      description:
        'Return the validated MungilBase config and its path. Secrets are never in the config; only environment variable names are shown.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      ok({
        configPath: deps.configPath,
        config,
      }),
  )

  server.registerTool(
    'database_info',
    {
      title: 'Database info',
      description: 'SQLite version, journal mode, page counts, file sizes and configured table count.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const pageCount = Number(db.pragma('page_count', { simple: true }))
      const pageSize = Number(db.pragma('page_size', { simple: true }))
      const dbFile = resolve(deps.dbFile)
      const walFile = `${dbFile}-wal`
      return ok({
        path: deps.dbFile,
        sqliteVersion: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
        journalMode: String(db.pragma('journal_mode', { simple: true })),
        pageCount,
        pageSize,
        freePages: Number(db.pragma('freelist_count', { simple: true })),
        sizeBytes: pageCount * pageSize,
        walSizeBytes: existsSync(walFile) ? statSync(walFile).size : 0,
        tables: registry.tables.size,
      })
    },
  )

  server.registerTool(
    'list_migrations',
    {
      title: 'List migrations',
      description: 'List code migrations and the ones recorded as applied in this database.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const hasTable = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(MIGRATIONS_TABLE)
      const applied = hasTable
        ? (db
            .prepare(`SELECT "id", "checksum", "applied_at" FROM "${MIGRATIONS_TABLE}" ORDER BY "id"`)
            .all() as Array<{ id: string; checksum: string; applied_at: string }>)
        : []
      const appliedIds = new Set(applied.map((row) => row.id))
      return ok({
        known: migrations.map((migration) => ({
          id: migration.id,
          applied: appliedIds.has(migration.id),
        })),
        applied,
      })
    },
  )

  server.registerTool(
    'migrate',
    {
      title: 'Migrate',
      description:
        'Apply pending code migrations, then additively sync tables and indexes from the config. Destructive schema changes are refused. Also ensures auth and audit tables exist.',
      inputSchema: {},
      annotations: MUTATING,
    },
    async () =>
      ok(
        await audited('mcp.admin.migrate', () => {
          const result = applyMigrations(db, migrations)
          const schema = ensureSchema(db, registry)
          ensureAuthSchema(db)
          ensureAuditSchema(db)
          return {
            applied: result.applied,
            created: schema.created,
            altered: schema.altered,
          }
        }),
      ),
  )

  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description: 'List accounts with role and email verification status. Never returns password hashes.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ limit, offset }) => {
      const result = await service.listUsers({ limit, offset })
      return ok({ ...result, count: result.users.length })
    },
  )

  server.registerTool(
    'create_user',
    {
      title: 'Create user',
      description:
        'Create an account. If password is omitted a random one is generated and returned once. Accounts start email-verified because the operator vouched for them.',
      inputSchema: {
        email: z.string().email(),
        password: z.string().min(8).max(128).optional(),
        role: z.enum(['user', 'admin']).optional().describe('Default user'),
        emailVerified: z.boolean().optional().describe('Default true'),
      },
      annotations: MUTATING,
    },
    async ({ email, password, role, emailVerified }) => {
      const generated = password ? null : generatePassword()
      const result = await audited(
        'mcp.admin.create_user',
        async () =>
          service.createUser(
            { email, password: password ?? generated ?? '' },
            role ?? 'user',
            emailVerified ?? true,
          ),
        { email, role: role ?? 'user', generatedPassword: generated !== null },
      )
      return ok({
        user: result,
        ...(generated ? { generatedPassword: generated } : {}),
      })
    },
  )

  server.registerTool(
    'set_user_role',
    {
      title: 'Set user role',
      description: 'Change an account role. Promotion alone never bypasses table rules.',
      inputSchema: {
        email: z.string().email(),
        role: z.enum(['user', 'admin']),
      },
      annotations: MUTATING,
    },
    async ({ email, role }) =>
      ok({
        user: await audited('mcp.admin.set_user_role', () => service.setRole(email, role), {
          email,
          role,
        }),
      }),
  )

  server.registerTool(
    'reset_user_password',
    {
      title: 'Reset user password',
      description:
        'Set an account password and revoke every session for it. If password is omitted a random one is generated and returned once.',
      inputSchema: {
        email: z.string().email(),
        password: z.string().min(8).max(128).optional(),
      },
      annotations: { ...MUTATING, destructiveHint: true },
    },
    async ({ email, password }) => {
      const generated = password ? null : generatePassword()
      const user = await audited(
        'mcp.admin.reset_user_password',
        () => service.setPassword(email, password ?? generated ?? ''),
        { email, generatedPassword: generated !== null },
      )
      return ok({ user, ...(generated ? { generatedPassword: generated } : {}) })
    },
  )

  server.registerTool(
    'delete_user',
    {
      title: 'Delete user',
      description:
        'Delete an account and cascade its sessions, tokens and verification records. Cannot delete the account running this MCP server.',
      inputSchema: {
        email: z.string().email(),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ email }) =>
      ok(
        await audited(
          'mcp.admin.delete_user',
          async () => {
            const user = await service.findUserByEmail(email)
            if (!user) throw notFound('No account with that email')
            if (user.id === identity.id) {
              throw badRequest('Refusing to delete the account this MCP server is running as')
            }
            await service.deleteUser(email)
            return { deleted: user }
          },
          { email },
        ),
      ),
  )

  server.registerTool(
    'list_audit',
    {
      title: 'List audit log',
      description: 'Read recent audit entries with optional filters. Newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        offset: z.number().int().min(0).optional(),
        event: z.string().optional(),
        outcome: z.enum(['success', 'denied', 'failure']).optional(),
        userId: z.string().optional(),
        table: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ limit = 50, offset = 0, event, outcome, userId, table }) => {
      const hasTable = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(AUDIT_TABLE)
      if (!hasTable) return ok({ entries: [], total: 0, count: 0 })

      const where: string[] = []
      const params: Array<string | number> = []
      if (event) {
        where.push('"event" = ?')
        params.push(event)
      }
      if (outcome) {
        where.push('"outcome" = ?')
        params.push(outcome)
      }
      if (userId) {
        where.push('"user_id" = ?')
        params.push(userId)
      }
      if (table) {
        where.push('"table_name" = ?')
        params.push(table)
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM "${AUDIT_TABLE}" ${clause}`).get(...params) as {
          n: number
        }
      ).n
      const entries = db
        .prepare(
          `SELECT * FROM "${AUDIT_TABLE}" ${clause} ORDER BY "id" DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as Array<Record<string, unknown>>
      return ok({ entries, total, count: entries.length })
    },
  )

  server.registerTool(
    'backup_database',
    {
      title: 'Back up database',
      description:
        'Take a verified online SQLite backup. Defaults to ./backups/mungil-<timestamp>.db.',
      inputSchema: {
        destination: z.string().optional().describe('Directory or exact .db path'),
      },
      annotations: MUTATING,
    },
    async ({ destination }) => {
      if (deps.dbFile === ':memory:') throw badRequest('Cannot back up an in-memory database.')
      const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      const target = destination?.endsWith('.db')
        ? resolve(destination)
        : resolve(destination ?? './backups', `mungil-${stamp}.db`)
      if (target === resolve(deps.dbFile)) {
        throw badRequest('Backup destination must not be the live database file')
      }
      return ok({
        backup: await audited('mcp.admin.backup', () => backupDatabase(db, target), {
          destination: target,
        }),
      })
    },
  )

  server.registerTool(
    'files_gc',
    {
      title: 'Collect orphaned files',
      description:
        'Find storage objects no row references. Dry run unless apply is true; deleting the wrong prefix is unrecoverable.',
      inputSchema: {
        apply: z.boolean().optional().describe('Default false'),
      },
      annotations: MUTATING,
    },
    async ({ apply }) => {
      const result = await audited(
        'mcp.admin.files_gc',
        () => runFileGc(db, registry, createStorage(config.storage), { apply: apply ?? false }),
        { apply: apply ?? false },
      )
      return ok({ apply: apply ?? false, ...result })
    },
  )

  server.registerTool(
    'generate_sdk',
    {
      title: 'Generate TypeScript SDK',
      description: 'Write the dependency-free typed client generated from the config.',
      inputSchema: {
        output: z.string().optional().describe('Default ./sdk/mungil-client.ts'),
      },
      annotations: MUTATING,
    },
    async ({ output }) => {
      const target = resolve(output ?? './sdk/mungil-client.ts')
      const code = generateSdk(config, { version: deps.version })
      await audited(
        'mcp.admin.generate_sdk',
        async () => {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, code, 'utf8')
          return target
        },
        { output: target, bytes: Buffer.byteLength(code, 'utf8') },
      )
      return ok({ output: target, bytes: Buffer.byteLength(code, 'utf8') })
    },
  )

  if (deps.allowRawSql) {
    server.registerTool(
      'query_sql',
      {
        title: 'Query SQL (read-only)',
        description:
          'Run one read-only SQL statement. Uses SQLite query_only, caps rows, and rejects writes. Bypasses table rules; admin only.',
        inputSchema: {
          sql: z.string().min(1).describe('A single SELECT/PRAGMA/EXPLAIN statement'),
          limit: z.number().int().min(1).max(1000).optional().describe('Default 200'),
        },
        annotations: READ_ONLY,
      },
      async ({ sql, limit = 200 }) => {
        const started = Date.now()
        const previous = Number(db.pragma('query_only', { simple: true }))
        let rows: unknown[] = []
        let truncated = false

        try {
          try {
            db.pragma('query_only = ON')
            const statement = db.prepare(sql)
            if (!statement.reader) {
              throw badRequest('query_sql only accepts statements that return rows')
            }
            for (const row of statement.iterate()) {
              if (rows.length >= limit) {
                truncated = true
                break
              }
              rows.push(row)
            }
          } finally {
            // Restore before auditing: the audit table also needs to be writable.
            db.pragma(`query_only = ${previous ? 'ON' : 'OFF'}`)
          }
        } catch (error) {
          audit('mcp.admin.query_sql', 'failure', {
            code: error instanceof AppError ? error.code : 'internal',
            metadata: { sql: truncate(sql) },
          })
          throw error
        }

        audit('mcp.admin.query_sql', 'success', {
          metadata: { sql: truncate(sql), rows: rows.length, truncated, durationMs: Date.now() - started },
        })
        return ok({ rows, count: rows.length, truncated })
      },
    )

    server.registerTool(
      'execute_sql',
      {
        title: 'Execute SQL',
        description:
          'Run arbitrary SQL, including writes and DDL. Bypasses table rules and the config schema. Admin only; every call is audited.',
        inputSchema: {
          sql: z.string().min(1).describe('SQL to execute; multiple statements are allowed'),
        },
        annotations: DESTRUCTIVE,
      },
      async ({ sql }) => {
        const started = Date.now()
        try {
          db.exec(sql)
          const result = db
            .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
            .get() as { changes: number; lastInsertRowid: number }
          audit('mcp.admin.execute_sql', 'success', {
            metadata: { sql: truncate(sql), changes: result.changes, durationMs: Date.now() - started },
          })
          return ok({ ok: true, ...result })
        } catch (error) {
          audit('mcp.admin.execute_sql', 'failure', {
            code: error instanceof AppError ? error.code : 'internal',
            metadata: { sql: truncate(sql) },
          })
          throw error
        }
      },
    )
  }
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url')
}

function truncate(value: string, length = 4000): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function ok(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

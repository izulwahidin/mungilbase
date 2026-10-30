import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { MungilConfig, TableConfig } from '../config/schema.js'
import type { Db } from '../db/connect.js'
import type { AuthContext } from '../auth/context.js'
import type { AuthRole } from '../auth/roles.js'
import type { RegisteredTable, Registry } from '../tables/registry.js'
import { createRow, deleteRow, listRows, updateRow, viewRow } from '../tables/crud.js'
import { AppError, badRequest } from '../http/errors.js'
import { buildOpenApi } from '../openapi/spec.js'
import { recordAudit } from '../audit/log.js'
import { registerAdminTools } from './admin.js'
import { VERSION } from '../version.js'

export interface McpIdentity {
  id: string
  email: string
  role: AuthRole
}

export interface CreateMcpServerOptions {
  config: MungilConfig
  registry: Registry
  db: Db
  /** Identity used for rule evaluation. Omit for anonymous access. */
  identity?: McpIdentity | null
  /** Table rules compiled against this context. */
  auth: AuthContext
  /** Register create/update/delete tools. Default false. */
  allowWrite?: boolean
  /** Register operator tools (schema, users, backups, audit). Requires an admin identity. */
  allowAdmin?: boolean
  /** Register query_sql/execute_sql. Requires allowAdmin. */
  allowRawSql?: boolean
  /** Restrict every tool and resource to these tables. Default: all. */
  tables?: readonly string[]
  /** Config path shown by get_config. */
  configPath?: string
  /** Database path shown by database_info and used for backups. */
  dbFile?: string
  version?: string
}

/** Where the MCP server is running and who it is acting as. */
export interface McpInfo {
  version: string
  identity: McpIdentity | null
  auth: AuthContext
  writeEnabled: boolean
  adminEnabled: boolean
  rawSqlEnabled: boolean
  tables: string[]
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, openWorldHint: false } as const

/**
 * Builds an MCP server over the same CRUD functions as HTTP and the admin
 * panel. There is no second query path: rules, validation, timestamps and
 * conflict handling are identical to the API.
 *
 * Read tools are always registered. Mutating tools are only registered when
 * the operator passed `--allow-write`; MCP clients cannot opt into writes by
 * themselves.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { config, registry, db, auth, identity = null } = options
  const version = options.version ?? VERSION
  const tableNames = resolveTables(registry, options.tables)
  const tableSet = new Set(tableNames)
  const allowWrite = options.allowWrite ?? false
  const allowAdmin = options.allowAdmin ?? false
  const allowRawSql = options.allowRawSql ?? false

  if (allowAdmin && (!identity || identity.role !== 'admin')) {
    throw new Error('Admin MCP tools require an identity with the admin role.')
  }
  if (allowRawSql && !allowAdmin) {
    throw new Error('Raw SQL tools require admin mode.')
  }

  const publicConfig: MungilConfig = {
    ...config,
    tables: config.tables.filter((table) => tableSet.has(table.name)),
  }

  const server = new McpServer(
    { name: 'mungilbase', version },
    {
      instructions: [
        'MungilBase exposes the configured database tables as tools.',
        'Every read and write is evaluated by the same row-level rules as the HTTP API.',
        'Call `whoami` first to see the active identity and whether writes are enabled.',
        'Use `list_tables` and `describe_table` before querying so you use real field names.',
        auth.uid
          ? `Acting as ${identity?.email ?? auth.uid}.`
          : 'Acting anonymously: rules that require auth.uid will deny or hide rows.',
      ].join(' '),
    },
  )

  const info = (): McpInfo => ({
    version,
    identity,
    auth,
    writeEnabled: allowWrite,
    adminEnabled: allowAdmin,
    rawSqlEnabled: allowRawSql,
    tables: tableNames,
  })

  const table = (name: string): RegisteredTable => {
    if (!tableSet.has(name)) {
      throw badRequest(`Table "${name}" is not exposed by this MCP server. Available: ${tableNames.join(', ')}`)
    }
    const registered = registry.get(name)
    if (!registered) {
      throw badRequest(`Unknown table "${name}". Available: ${tableNames.join(', ')}`)
    }
    return registered
  }

  const schemaSummary = (): Array<Record<string, unknown>> =>
    publicConfig.tables.map((entry) => describeTable(entry))

  const tableSchemaResource = (): string => JSON.stringify({ tables: schemaSummary() }, null, 2)
  const openapiResource = (): string =>
    JSON.stringify(buildOpenApi(publicConfig, version), null, 2)

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Show the MCP identity, whether writes are enabled, and which tables this server exposes.',
      inputSchema: {},
      outputSchema: {
        version: z.string(),
        identity: z.union([z.record(z.string(), z.unknown()), z.null()]),
        auth: z.record(z.string(), z.unknown()),
        writeEnabled: z.boolean(),
        adminEnabled: z.boolean(),
        rawSqlEnabled: z.boolean(),
        tables: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    async () => ok({ ...info() }),
  )

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'List the tables exposed by this MCP server with their fields and access rules. Call this before querying.',
      inputSchema: {},
      outputSchema: {
        tables: z.array(z.record(z.string(), z.unknown())),
        count: z.number(),
      },
      annotations: READ_ONLY,
    },
    async () => ok({ tables: schemaSummary(), count: tableNames.length }),
  )

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Describe one table: fields, types, defaults, indexes, timestamps and the five access rules.',
      inputSchema: {
        table: z.string().describe('Table name, as returned by list_tables'),
      },
      annotations: READ_ONLY,
    },
    async ({ table: name }) => {
      const registered = table(name)
      return ok(describeTable(registered.config))
    },
  )

  server.registerTool(
    'list_rows',
    {
      title: 'List rows',
      description:
        'List rows visible to the active identity. Supports the MungilBase filter expression, sort (`title` or `-title`), limit (1-200) and offset. Returns `{ items, limit, offset, count }`.',
      inputSchema: {
        table: z.string().describe('Table name'),
        filter: z
          .string()
          .optional()
          .describe("Optional expression, e.g. published == true & title ~ '%hello%'"),
        sort: z.string().optional().describe('Column name, or -column for descending'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: {
        items: z.array(z.record(z.string(), z.unknown())),
        limit: z.number(),
        offset: z.number(),
        count: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ table: name, filter, sort, limit, offset }) => {
      const registered = table(name)
      const result = listRows(db, registered, auth, { filter, sort, limit, offset })
      return ok({ ...result, count: result.items.length })
    },
  )

  server.registerTool(
    'get_row',
    {
      title: 'Get row',
      description:
        'Get one row by id. Rows hidden by the view rule return not_found. Returns `{ row }`.',
      inputSchema: {
        table: z.string().describe('Table name'),
        id: z.string().describe('Row id'),
      },
      outputSchema: { row: z.record(z.string(), z.unknown()) },
      annotations: READ_ONLY,
    },
    async ({ table: name, id }) => {
      const registered = table(name)
      return ok({ row: viewRow(db, registered, auth, id) })
    },
  )

  server.registerTool(
    'get_openapi',
    {
      title: 'Get OpenAPI document',
      description:
        'Return the OpenAPI 3.1 document generated from the config, limited to the tables this server exposes. Returns `{ openapi }`.',
      inputSchema: {},
      outputSchema: { openapi: z.record(z.string(), z.unknown()) },
      annotations: READ_ONLY,
    },
    async () => ok({ openapi: buildOpenApi(publicConfig, version) }),
  )

  server.registerResource(
    'schema',
    'mungilbase://schema',
    {
      title: 'MungilBase schema',
      description: 'Tables, fields and access rules exposed by this MCP server.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: tableSchemaResource() }],
    }),
  )

  server.registerResource(
    'openapi',
    'mungilbase://openapi.json',
    {
      title: 'MungilBase OpenAPI document',
      description: 'OpenAPI 3.1 document generated from the same config that drives the API.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: openapiResource() }],
    }),
  )

  const auditWrite = <T extends Record<string, unknown>>(
    name: string,
    operation: 'create' | 'update' | 'delete',
    write: () => T,
  ): T => {
    try {
      const row = write()
      recordAudit(db, {
        event: `mcp.${operation}`,
        outcome: 'success',
        userId: auth.uid,
        table: name,
        operation,
        resourceId: row.id === undefined ? null : String(row.id),
        metadata: { via: 'mcp' },
      })
      return row
    } catch (error) {
      recordAudit(db, {
        event: `mcp.${operation}`,
        outcome: error instanceof AppError && error.code === 'rule_violation' ? 'denied' : 'failure',
        userId: auth.uid,
        table: name,
        operation,
        code: error instanceof AppError ? error.code : 'internal',
        metadata: { via: 'mcp' },
      })
      throw error
    }
  }

  if (allowWrite) {
    server.registerTool(
      'create_row',
      {
        title: 'Create row',
        description:
          'Create a row. The create rule is evaluated inside SQLite; a denied write returns rule_violation and inserts nothing. Returns `{ row }` with the stored values, including the new id.',
        inputSchema: {
          table: z.string().describe('Table name'),
          values: z.record(z.string(), z.unknown()).describe('Field values; unknown or invalid fields are rejected'),
        },
        outputSchema: { row: z.record(z.string(), z.unknown()) },
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
      },
      async ({ table: name, values }) => {
        const registered = table(name)
        assertNoFileFields(registered, values)
        return ok({
          row: auditWrite(name, 'create', () => createRow(db, registered, auth, values)),
        })
      },
    )

    server.registerTool(
      'update_row',
      {
        title: 'Update row',
        description:
          'Update one row by id. Only fields present in `values` are changed; the update rule is evaluated in SQLite. Returns `{ row }`.',
        inputSchema: {
          table: z.string().describe('Table name'),
          id: z.string().describe('Row id'),
          values: z.record(z.string(), z.unknown()).describe('Fields to change'),
        },
        outputSchema: { row: z.record(z.string(), z.unknown()) },
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ table: name, id, values }) => {
        const registered = table(name)
        assertNoFileFields(registered, values)
        return ok({
          row: auditWrite(name, 'update', () => updateRow(db, registered, auth, id, values)),
        })
      },
    )

    server.registerTool(
      'delete_row',
      {
        title: 'Delete row',
        description:
          'Delete one row by id. The delete rule is evaluated in SQLite; files referenced by the row are removed too.',
        inputSchema: {
          table: z.string().describe('Table name'),
          id: z.string().describe('Row id'),
        },
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
      },
      async ({ table: name, id }) => {
        const registered = table(name)
        return ok({
          row: auditWrite(name, 'delete', () => deleteRow(db, registered, auth, id)),
        })
      },
    )
  }

  if (allowAdmin) {
    registerAdminTools(server, {
      config,
      registry,
      db,
      identity,
      configPath: options.configPath ?? null,
      dbFile: options.dbFile ?? config.database.file,
      version,
      allowRawSql,
    })
  }

  return server
}

function resolveTables(registry: Registry, only: readonly string[] | undefined): string[] {
  const configured = [...registry.tables.keys()]
  if (!only || only.length === 0) return configured

  const unknown = only.filter((name) => !registry.tables.has(name))
  if (unknown.length) {
    throw badRequest(
      `Unknown table(s) in --tables: ${unknown.join(', ')}. Configured: ${configured.join(', ') || '(none)'}`,
    )
  }
  return configured.filter((name) => only.includes(name))
}

function describeTable(table: TableConfig): Record<string, unknown> {
  return {
    name: table.name,
    timestamps: table.timestamps,
    fields: table.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      unique: field.unique,
      default: field.default,
      ...(field.type === 'file'
        ? { maxBytes: field.maxBytes, allowedTypes: field.allowedTypes }
        : {}),
      ...(field.references ? { references: field.references } : {}),
    })),
    indexes: table.indexes,
    rules: table.rules,
  }
}

function assertNoFileFields(table: RegisteredTable, values: Record<string, unknown>): void {
  const fileFields = Object.keys(values).filter(
    (name) => table.fields.get(name)?.type === 'file',
  )
  if (fileFields.length) {
    throw badRequest(
      `File field(s) ${fileFields.join(', ')} must be uploaded through the HTTP files route, not MCP.`,
    )
  }
}

function ok(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

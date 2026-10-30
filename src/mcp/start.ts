import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { findConfigPath, loadConfig } from '../config/load.js'
import { authConfigSchema, type MungilConfig } from '../config/schema.js'
import { openDatabase, type Db } from '../db/connect.js'
import { applyMigrations } from '../db/migrator.js'
import { migrations } from '../db/migrations.js'
import { ensureSchema } from '../db/ddl.js'
import { createRegistry, type Registry } from '../tables/registry.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAuditSchema } from '../audit/log.js'
import { AuthService } from '../auth/service.js'
import { anonymous, type AuthContext } from '../auth/context.js'
import { createMcpServer, type McpIdentity } from './server.js'
import { VERSION } from '../version.js'

export interface McpCommandOptions {
  configPath?: string
  /** Email of the account whose rules apply. Omit for anonymous access. */
  user?: string
  /** Register create/update/delete tools. */
  allowWrite?: boolean
  /** Register operator tools. Requires --user with the admin role. */
  admin?: boolean
  /** Register query_sql/execute_sql. Requires admin mode. */
  allowRawSql?: boolean
  /** Restrict the exposed tables. */
  tables?: readonly string[]
  version?: string
}

export interface McpContext {
  configPath: string
  config: MungilConfig
  dbFile: string
  db: Db
  registry: Registry
  identity: McpIdentity | null
  auth: AuthContext
  server: McpServer
}

/**
 * Opens the database, brings the schema up to date, resolves the identity, and
 * builds the MCP server. Exposed separately so tests can use an in-memory
 * transport without spawning a subprocess.
 */
export async function openMcpContext(options: McpCommandOptions = {}): Promise<McpContext> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file
  const db = openDatabase(dbFile)

  try {
    applyMigrations(db, migrations)
    const registry = createRegistry(config)
    ensureSchema(db, registry)
    ensureAuthSchema(db)
    ensureAuditSchema(db)

    const identity = options.user ? await resolveIdentity(db, config, options.user) : null
    if (options.admin && (!identity || identity.role !== 'admin')) {
      throw new Error('--admin requires --user with an account whose role is admin.')
    }
    if (options.allowRawSql && !options.admin) {
      throw new Error('--allow-raw-sql requires --admin.')
    }

    const bypass = identity?.role === 'admin' && (config.auth?.adminBypassRules ?? false)
    const auth: AuthContext = identity
      ? {
          uid: identity.id,
          role: identity.role,
          verified: identity.emailVerified,
          admin: bypass,
        }
      : anonymous

    const server = createMcpServer({
      config,
      registry,
      db,
      identity,
      auth,
      allowWrite: options.allowWrite ?? false,
      allowAdmin: options.admin ?? false,
      allowRawSql: options.allowRawSql ?? false,
      tables: options.tables,
      configPath,
      dbFile,
      version: options.version ?? VERSION,
    })

    return { configPath, config, dbFile, registry, identity, auth, db, server }
  } catch (error) {
    db.close()
    throw error
  }
}

async function resolveIdentity(
  db: Db,
  config: MungilConfig,
  email: string,
): Promise<McpIdentity> {
  const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
  const user = await service.findUserByEmail(email)

  if (!user) {
    throw new Error(
      `No account with email ${email}. Create one with \`mungilbase user create ${email}\`.`,
    )
  }
  if (config.auth?.emailVerification.required && !user.emailVerified) {
    throw new Error(`Account ${email} is not email-verified.`)
  }

  return user
}

/**
 * Runs the MCP server over stdio. stdout belongs to the protocol, so every
 * diagnostic here goes to stderr.
 */
export async function runMcpServer(options: McpCommandOptions = {}): Promise<void> {
  const context = await openMcpContext(options)
  const transport = new StdioServerTransport()
  await context.server.connect(transport)

  diag({
    event: 'mcp_ready',
    transport: 'stdio',
    identity: context.identity?.email ?? null,
    write: options.allowWrite ?? false,
    admin: options.admin ?? false,
    rawSql: options.allowRawSql ?? false,
    tables: [...context.registry.tables.keys()],
    database: context.dbFile,
    version: options.version ?? VERSION,
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    diag({ event: 'mcp_shutdown', signal })
    void context.server
      .close()
      .catch(() => undefined)
      .finally(() => {
        try {
          context.db.close()
        } catch {
          // Already closed.
        }
        process.exit(0)
      })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('exit', () => {
    try {
      context.db.close()
    } catch {
      // Already closed.
    }
  })
}

function diag(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'info', ...fields }))
}

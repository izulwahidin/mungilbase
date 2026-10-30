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
  /** Flags after config defaults were applied. */
  options: Required<Pick<McpCommandOptions, 'allowWrite' | 'admin' | 'allowRawSql'>> &
    Pick<McpCommandOptions, 'user' | 'tables'>
}

/**
 * Command-line flags win, then `mcp` in the config file. A client config can
 * therefore stay as short as `mungilbase mcp`.
 */
export function applyMcpDefaults(
  options: McpCommandOptions,
  config: MungilConfig,
): McpCommandOptions {
  const defaults = config.mcp
  return {
    ...options,
    user: options.user ?? defaults?.user,
    tables: options.tables ?? defaults?.tables,
    allowWrite: (options.allowWrite ?? false) || (defaults?.allowWrite ?? false),
    admin: (options.admin ?? false) || (defaults?.admin ?? false),
    allowRawSql: (options.allowRawSql ?? false) || (defaults?.allowRawSql ?? false),
  }
}

/**
 * Opens the database, brings the schema up to date, resolves the identity, and
 * builds the MCP server. Exposed separately so tests can use an in-memory
 * transport without spawning a subprocess.
 */
export async function openMcpContext(options: McpCommandOptions = {}): Promise<McpContext> {
  const configPath = findConfigPath(options.configPath)
  const loaded = await loadConfig(configPath)
  const config = loaded
  const effective = applyMcpDefaults(options, config)
  const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file
  const db = openDatabase(dbFile)

  try {
    applyMigrations(db, migrations)
    const registry = createRegistry(config)
    ensureSchema(db, registry)
    ensureAuthSchema(db)
    ensureAuditSchema(db)

    const identity = effective.user ? await resolveIdentity(db, config, effective.user) : null
    if (effective.admin && (!identity || identity.role !== 'admin')) {
      throw new Error('--admin requires --user with an account whose role is admin.')
    }
    if (effective.allowRawSql && !effective.admin) {
      throw new Error('--allow-raw-sql requires --admin.')
    }

    const bypass = identity?.role === 'admin' && (config.auth?.adminBypassRules ?? false)
    const auth: AuthContext = identity
      ? {
          uid: identity.id,
          role: identity.role,
          admin: bypass,
        }
      : anonymous

    const server = createMcpServer({
      config,
      registry,
      db,
      identity,
      auth,
      allowWrite: effective.allowWrite ?? false,
      allowAdmin: effective.admin ?? false,
      allowRawSql: effective.allowRawSql ?? false,
      tables: effective.tables,
      configPath,
      dbFile,
      version: options.version ?? VERSION,
    })

    return {
      configPath,
      config,
      dbFile,
      registry,
      identity,
      auth,
      server,
      db,
      options: {
        user: effective.user,
        tables: effective.tables,
        allowWrite: effective.allowWrite ?? false,
        admin: effective.admin ?? false,
        allowRawSql: effective.allowRawSql ?? false,
      },
    }
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
  const effective = context.options

  diag({
    event: 'mcp_ready',
    transport: 'stdio',
    identity: context.identity?.email ?? null,
    write: effective.allowWrite,
    admin: effective.admin,
    rawSql: effective.allowRawSql,
    tables: [...context.registry.tables.keys()],
    database: context.dbFile,
    version: options.version ?? VERSION,
  })

  if (effective.allowWrite && !context.identity) {
    diag({
      level: 'warn',
      event: 'mcp_write_without_identity',
      message:
        'Writes are enabled but the identity is anonymous; rules that compare auth.uid will deny them. Pass --user <email> or set mcp.user in the config.',
    })
  }

  // A client launches this process over stdio. If nothing arrives, the launch
  // path is the usual suspect (an npm/npx wrapper that does not forward the
  // pipe), so say that instead of hanging silently.
  let sawTraffic = false
  const timer = setTimeout(() => {
    if (sawTraffic) return
    diag({
      level: 'warn',
      event: 'mcp_no_initialize',
      message:
        'No MCP request received in 10s. If a client launched this via npx, the npm wrapper may not forward stdio; point the client at the node binary and the mungilbase CLI file instead. Run `mungilbase mcp --print-config <client>` for a ready-made entry.',
    })
  }, 10_000)
  timer.unref()

  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((...args: Parameters<typeof write>) => {
    if (!sawTraffic) {
      sawTraffic = true
      clearTimeout(timer)
    }
    return write(...args)
  }) as typeof process.stdout.write

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

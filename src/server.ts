import { serve } from '@hono/node-server'
import { loadConfig } from './config/load.js'
import { openDatabase } from './db/connect.js'
import { applyMigrations } from './db/migrator.js'
import { migrations } from './db/migrations.js'
import { ensureSchema } from './db/ddl.js'
import { createApp } from './http/app.js'
import { createRegistry } from './tables/registry.js'
import { ensureAuthSchema } from './auth/schema.js'
import { ensureAuditSchema } from './audit/log.js'
import { createErrorReporter } from './telemetry/sentry.js'
import { VERSION } from './version.js'
import type { MungilConfig } from './config/schema.js'
import type { Db } from './db/connect.js'

export interface StartServerOptions {
  /** Config file. Defaults to `MUNGIL_CONFIG` or the first `mungil.config.*`. */
  configPath?: string
  /** Listen address. Defaults to `HOST` or `server.host`. */
  host?: string
  /** Listen port. Defaults to `PORT` or `server.port`. */
  port?: number
  /** Reported version. Defaults to `MUNGIL_VERSION` or the package version. */
  version?: string
  /**
   * Install SIGINT/SIGTERM/uncaught-exception handlers and exit the process
   * on shutdown. Enabled for the CLI and `npm start`; disable when
   * embedding the server in another process.
   */
  handleSignals?: boolean
}

export interface RunningServer {
  config: MungilConfig
  dbFile: string
  host: string
  port: number
  /** Stop accepting requests, then close the database. */
  close(): Promise<void>
}

/**
 * Boots a MungilBase server: config validation, migrations, additive schema
 * sync, and the HTTP listener. Extracted from `index.ts` so the CLI, the
 * container entrypoint and library users share exactly one boot path.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const version = options.version ?? VERSION
  const config = await loadConfig(options.configPath)
  const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file
  const db = openDatabase(dbFile)

  try {
    const result = applyMigrations(db, migrations)
    if (result.applied.length) {
      log({ event: 'migrations_applied', migrations: result.applied })
    }

    // Schema sync is additive and fails loudly on anything destructive.
    const registry = createRegistry(config)
    const schema = ensureSchema(db, registry)
    ensureAuthSchema(db)
    ensureAuditSchema(db)
    if (schema.created.length || schema.altered.length) {
      log({ event: 'schema_synced', ...schema })
    }

    const reportError = createErrorReporter({
      dsn: process.env.MUNGIL_SENTRY_DSN,
      environment: process.env.NODE_ENV,
      release: version,
    })

    const app = createApp({
      config,
      db,
      dbFile,
      version,
      registry,
      reportError,
    })

    if (options.handleSignals !== false) installProcessHandlers(reportError)

    const host = options.host ?? process.env.HOST ?? config.server.host
    const port = options.port ?? Number(process.env.PORT ?? config.server.port)

    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      let listening = false
      const instance = serve(
        { fetch: app.fetch, hostname: host, port },
        (info) => {
          listening = true
          log({
            event: 'listening',
            host: info.address,
            port: info.port,
            database: dbFile,
            version,
          })
          resolve(instance)
        },
      )
      instance.once('error', (error) => {
        if (!listening) reject(error)
      })
    })

    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    }

    if (options.handleSignals !== false) {
      installShutdownHandlers(close, db)
    }

    return {
      config,
      dbFile,
      host,
      port,
      close,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', ...fields }))
}

type ErrorReporter = ReturnType<typeof createErrorReporter>

function installProcessHandlers(reportError: ErrorReporter): void {
  process.on('uncaughtException', (error) => {
    reportError(error, { scope: 'uncaughtException' })
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'uncaught_exception',
        message: error.message,
        stack: error.stack,
      }),
    )
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    reportError(reason, { scope: 'unhandledRejection' })
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'unhandled_rejection',
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    )
  })
}

function installShutdownHandlers(close: () => Promise<void>, db: Db): void {
  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log({ event: 'shutdown', signal })

    // Stop accepting new work, then close the database once in-flight requests
    // have finished. Force an exit if something hangs.
    const force = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_timeout' }))
      process.exit(1)
    }, 10_000)
    force.unref()

    void close()
      .then(() => {
        clearTimeout(force)
        process.exit(0)
      })
      .catch(() => {
        try {
          db.close()
        } catch {
          // already closed
        }
        clearTimeout(force)
        process.exit(1)
      })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

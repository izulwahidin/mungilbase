import { serve } from '@hono/node-server'
import { loadConfig, ConfigError } from './config/load.js'
import { openDatabase } from './db/connect.js'
import { applyMigrations, MigrationError } from './db/migrator.js'
import { migrations } from './db/migrations.js'
import { ensureSchema } from './db/ddl.js'
import { createApp } from './http/app.js'
import { createRegistry, SchemaError } from './tables/registry.js'
import { ensureAuthSchema } from './auth/schema.js'
import { ensureAuditSchema } from './audit/log.js'
import { createErrorReporter } from './telemetry/sentry.js'
import type { Db } from './db/connect.js'

const VERSION = process.env.MUNGIL_VERSION ?? '0.2.0'
// Argument wins over environment so `node dist/index.js ./config.json` works
// even when the process environment is managed by an orchestrator.
const CONFIG_PATH = process.argv[2] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH)
  const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file
  const db = openDatabase(dbFile)

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
    release: VERSION,
  })

  const app = createApp({
    config,
    db,
    dbFile,
    version: VERSION,
    registry,
    reportError,
  })

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

  const server = serve(
    {
      fetch: app.fetch,
      hostname: process.env.HOST ?? config.server.host,
      port: Number(process.env.PORT ?? config.server.port),
    },
    (info) => {
      log({
        event: 'listening',
        host: info.address,
        port: info.port,
        database: dbFile,
        version: VERSION,
      })
    },
  )

  installShutdownHandlers(server, db)
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', ...fields }))
}

function installShutdownHandlers(server: { close(callback: () => void): void }, db: Db): void {
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

    server.close(() => {
      db.close()
      clearTimeout(force)
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof SchemaError || error instanceof MigrationError) {
    console.error(`Startup failed: ${error.message}`)
  } else {
    console.error(error)
  }
  process.exit(1)
})

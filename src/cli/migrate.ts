import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { migrations } from '../db/migrations.js'
import { applyMigrations, MigrationError } from '../db/migrator.js'
import { ensureSchema } from '../db/ddl.js'
import { createRegistry, SchemaError } from '../tables/registry.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAuditSchema } from '../audit/log.js'

const configPath = process.argv[2] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'
const config = await loadConfig(configPath)
const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file

const db = openDatabase(dbFile)
try {
  const { applied } = applyMigrations(db, migrations)
  if (applied.length === 0) {
    console.log('No pending migrations.')
  } else {
    for (const id of applied) console.log(`Applied ${id}`)
  }

  const schema = ensureSchema(db, createRegistry(config))
  ensureAuthSchema(db)
  ensureAuditSchema(db)
  if (schema.created.length) console.log(`Created: ${schema.created.join(', ')}`)
  for (const change of schema.altered) {
    console.log(`Altered: ${change.table} (+${change.columns.join(', +')})`)
  }
  if (!schema.created.length && !schema.altered.length) console.log('Schema is up to date.')
} catch (error) {
  if (error instanceof MigrationError || error instanceof SchemaError) {
    console.error(`Migration failed: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  db.close()
}

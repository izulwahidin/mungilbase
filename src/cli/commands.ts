import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { findConfigPath, loadConfig } from '../config/load.js'
import { authConfigSchema } from '../config/schema.js'
import { openDatabase } from '../db/connect.js'
import { backupDatabase } from '../db/backup.js'
import { migrations } from '../db/migrations.js'
import { applyMigrations } from '../db/migrator.js'
import { ensureSchema } from '../db/ddl.js'
import { createRegistry } from '../tables/registry.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAuditSchema } from '../audit/log.js'
import { AuthService } from '../auth/service.js'
import { isAuthRole } from '../auth/roles.js'
import { createStorage } from '../storage/storage.js'
import { runFileGc } from '../storage/gc.js'
import { generateSdk } from '../sdk/generate.js'
import { buildOpenApi } from '../openapi/spec.js'
import { VERSION } from '../version.js'
import type { MungilConfig } from '../config/schema.js'

export interface CommandOptions {
  /** Config path. When omitted, the standard discovery order is used. */
  configPath?: string
  version?: string
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', ...fields }))
}

function databaseFile(config: MungilConfig): string {
  return process.env.MUNGIL_DB_FILE ?? config.database.file
}

/** Applies checksummed migrations and the additive schema sync. */
export async function migrate(options: CommandOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))

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
  } finally {
    db.close()
  }
}

/**
 * Validates the config (including every rule) without opening the database or
 * starting a listener. Useful as a first step on an unfamiliar deployment.
 */
export async function doctor(options: CommandOptions = {}): Promise<void> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  // Compiling every rule is the expensive validation; do it here so a broken
  // rule fails in `doctor`, not on the first request.
  createRegistry(config)

  const summary = {
    version: options.version ?? VERSION,
    config: configPath,
    database: resolve(databaseFile(config)),
    appUrl: config.appUrl ?? null,
    auth: config.auth ? 'enabled' : 'disabled',
    storage: config.storage?.provider ?? 'none',
    tables: config.tables.map((table) => ({
      name: table.name,
      fields: table.fields.length,
    })),
  }

  console.log(`MungilBase ${summary.version}`)
  console.log(`Config    ${summary.config}`)
  console.log(`Database  ${summary.database}`)
  console.log(`App URL   ${summary.appUrl ?? '(not set)'}`)
  console.log(`Auth      ${summary.auth}`)
  console.log(`Storage   ${summary.storage}`)
  console.log(
    `Tables    ${summary.tables.length ? summary.tables.map((t) => `${t.name} (${t.fields} fields)`).join(', ') : '(none)'}`,
  )
}

/** Takes a verified online backup. */
export async function backup(options: CommandOptions & { destination?: string } = {}): Promise<void> {
  const config = await loadConfig(options.configPath)
  const dbFile = databaseFile(config)

  if (dbFile === ':memory:') {
    throw new Error('Cannot back up an in-memory database.')
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const destination = options.destination?.endsWith('.db')
    ? resolve(options.destination)
    : resolve(options.destination ?? './backups', `mungil-${stamp}.db`)

  const db = openDatabase(dbFile, {})
  try {
    const result = await backupDatabase(db, destination)
    log({ event: 'backup_complete', ...result, source: resolve(dbFile) })
  } finally {
    db.close()
  }
}

/** Writes the OpenAPI 3.1 document generated from the config. */
export async function openapi(
  options: CommandOptions & { output?: string } = {},
): Promise<void> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  const output = resolve(options.output ?? './openapi.json')
  const document = buildOpenApi(config, options.version ?? VERSION)

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  log({ event: 'openapi_generated', config: configPath, output })
}

/** Generates the dependency-free typed TypeScript client. */
export async function sdk(options: CommandOptions & { output?: string } = {}): Promise<void> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  const output = resolve(options.output ?? './sdk/mungil-client.ts')
  const code = generateSdk(config, { version: options.version ?? VERSION })

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, code, 'utf8')
  log({
    event: 'sdk_generated',
    config: configPath,
    output,
    bytes: Buffer.byteLength(code, 'utf8'),
  })
}

/** Collects uploaded objects that no row references. Dry run by default. */
export async function filesGc(
  options: CommandOptions & { apply?: boolean } = {},
): Promise<void> {
  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))

  try {
    const result = await runFileGc(db, createRegistry(config), createStorage(config.storage), {
      apply: options.apply ?? false,
    })
    log({ event: 'files_gc', apply: options.apply ?? false, ...result })
  } finally {
    db.close()
  }
}

export async function createUser(
  email: string,
  options: CommandOptions & { role?: string; password?: string } = {},
): Promise<void> {
  const password = options.password ?? process.env.MUNGIL_USER_PASSWORD
  const role = options.role ?? process.env.MUNGIL_USER_ROLE ?? 'user'

  if (!password) {
    throw new Error('Set MUNGIL_USER_PASSWORD to create a user.')
  }
  if (!isAuthRole(role)) {
    throw new Error('Role must be one of: user, admin')
  }

  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))
  try {
    ensureAuthSchema(db)
    const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
    const user = await service.createUser({ email, password }, role)
    console.log(`Created ${user.role} ${user.id} <${user.email}>`)
  } finally {
    db.close()
  }
}

export async function resetPassword(
  email: string,
  options: CommandOptions & { password?: string } = {},
): Promise<void> {
  const password = options.password ?? process.env.MUNGIL_USER_PASSWORD
  if (!password) {
    throw new Error('Set MUNGIL_USER_PASSWORD to reset a password.')
  }

  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))
  try {
    ensureAuthSchema(db)
    const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
    const user = await service.setPassword(email, password)
    console.log(`Updated password for ${user.id} <${user.email}>; all sessions revoked.`)
  } finally {
    db.close()
  }
}

export async function setRole(
  email: string,
  role: string,
  options: CommandOptions = {},
): Promise<void> {
  if (!isAuthRole(role)) {
    throw new Error('Role must be one of: user, admin')
  }

  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))
  try {
    ensureAuthSchema(db)
    const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
    const user = await service.setRole(email, role)
    console.log(`Set role "${user.role}" for ${user.id} <${user.email}>`)
  } finally {
    db.close()
  }
}

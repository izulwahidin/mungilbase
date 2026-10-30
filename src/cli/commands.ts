import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { findConfigPath, loadConfig } from '../config/load.js'
import { resolveEnvFile } from './env.js'
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

export interface ArtifactStatus {
  kind: 'openapi' | 'sdk'
  path: string
  /** True when the file is missing or differs from what the config generates. */
  stale: boolean
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
export async function doctor(
  options: CommandOptions & { json?: boolean } = {},
): Promise<void> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  // Compiling every rule is the expensive validation; do it here so a broken
  // rule fails in `doctor`, not on the first request.
  createRegistry(config)

  const envFile = resolveEnvFile()
  const artifacts = await artifactStatus(config, options.version ?? VERSION)
  const stale = artifacts.filter((artifact) => artifact.stale)
  const databasePath = resolve(databaseFile(config))
  const warnings = filesystemWarnings(databasePath)

  const summary = {
    version: options.version ?? VERSION,
    config: configPath,
    database: databasePath,
    appUrl: config.appUrl ?? null,
    static: config.static ? resolve(config.static.dir) : null,
    auth: config.auth ? 'enabled' : 'disabled',
    storage: config.storage?.provider ?? 'none',
    envFile: envFile.path ? { path: envFile.path, exists: true } : null,
    mcp: config.mcp
      ? {
          user: config.mcp.user ?? null,
          tables: config.mcp.tables ?? null,
          allowWrite: config.mcp.allowWrite,
          admin: config.mcp.admin,
          allowRawSql: config.mcp.allowRawSql,
        }
      : null,
    artifacts,
    warnings,
    tables: config.tables.map((table) => ({
      name: table.name,
      fields: table.fields.length,
    })),
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  console.log(`MungilBase ${summary.version}`)
  console.log(`Config    ${summary.config}`)
  console.log(`Database  ${summary.database}`)
  console.log(`App URL   ${summary.appUrl ?? '(not set)'}`)
  console.log(`Static    ${summary.static ?? '(not served)'}`)
  console.log(`Auth      ${summary.auth}`)
  console.log(`Storage   ${summary.storage}`)
  console.log(
    `Env file  ${summary.envFile ? summary.envFile.path : '(none — copy .env.example to .env)'}`,
  )
  console.log(
    `MCP       ${
      summary.mcp
        ? `user=${summary.mcp.user ?? 'anonymous'} tables=${summary.mcp.tables?.join(',') ?? 'all'} write=${
            summary.mcp.allowWrite ? 'on' : 'off'
          } admin=${summary.mcp.admin ? 'on' : 'off'} rawSql=${summary.mcp.allowRawSql ? 'on' : 'off'}`
        : '(no defaults; pass flags or set mcp in the config)'
    }`,
  )
  console.log(
    `Tables    ${summary.tables.length ? summary.tables.map((t) => `${t.name} (${t.fields} fields)`).join(', ') : '(none)'}`,
  )
  console.log(
    `Generated ${stale.length ? `stale: ${stale.map((artifact) => artifact.path).join(', ')} (run \`mungilbase gen\`)` : 'up to date'}`,
  )
  for (const warning of warnings) console.log(`Note      ${warning}`)
  if (config.mcp?.user || config.mcp?.allowWrite) {
    console.log('')
    console.log('MCP: run `mungilbase mcp --check` to exercise the server, then')
    console.log('     `mungilbase mcp --print-config <opencode|claude|cursor|vscode|raw>`.')
  }
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

/** Generates the OpenAPI document and the typed client in one step. */
export async function gen(
  options: CommandOptions & { check?: boolean } = {},
): Promise<{ artifacts: ArtifactStatus[]; stale: ArtifactStatus[] }> {
  const configPath = findConfigPath(options.configPath)
  const config = await loadConfig(configPath)
  const artifacts = await artifactStatus(config, options.version ?? VERSION)

  for (const artifact of artifacts) {
    if (!artifact.stale || options.check) continue
    const contents = await artifactContents(config, options.version ?? VERSION, artifact.kind)
    await mkdir(dirname(artifact.path), { recursive: true })
    await writeFile(artifact.path, contents, 'utf8')
    log({ event: `${artifact.kind}_generated`, config: configPath, output: artifact.path })
  }

  return { artifacts, stale: artifacts.filter((artifact) => artifact.stale) }
}

async function plannedArtifacts(
  config: MungilConfig,
  version: string,
): Promise<Array<ArtifactStatus & { contents: string }>> {
  const openapiPath = resolve('./openapi.json')
  const sdkPath = resolve('./sdk/mungil-client.ts')
  return [
    {
      kind: 'openapi',
      path: openapiPath,
      contents: `${JSON.stringify(buildOpenApi(config, version), null, 2)}\n`,
      stale: true,
    },
    {
      kind: 'sdk',
      path: sdkPath,
      contents: generateSdk(config, { version }),
      stale: true,
    },
  ]
}

async function artifactContents(
  config: MungilConfig,
  version: string,
  kind: ArtifactStatus['kind'],
): Promise<string> {
  const artifacts = await plannedArtifacts(config, version)
  const match = artifacts.find((artifact) => artifact.kind === kind)
  return match?.contents ?? ''
}

/** Compares what the config generates with what is on disk. */
async function artifactStatus(config: MungilConfig, version: string): Promise<ArtifactStatus[]> {
  const planned = await plannedArtifacts(config, version)
  const statuses: ArtifactStatus[] = []

  for (const artifact of planned) {
    const existing = await readFile(artifact.path, 'utf8').catch(() => null)
    statuses.push({
      kind: artifact.kind,
      path: artifact.path,
      stale: existing !== artifact.contents,
    })
  }

  return statuses
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
): Promise<{ id: string; email: string; role: string }> {
  const password = options.password ?? passwordFromEnv()
  const role = options.role ?? process.env.MUNGIL_USER_ROLE ?? 'user'

  if (!password) {
    throw new Error(passwordHelp('create'))
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
    return user
  } finally {
    db.close()
  }
}

export async function resetPassword(
  email: string,
  options: CommandOptions & { password?: string } = {},
): Promise<{ id: string; email: string }> {
  const password = options.password ?? passwordFromEnv()
  if (!password) {
    throw new Error(passwordHelp('reset a password for'))
  }

  const config = await loadConfig(options.configPath)
  const db = openDatabase(databaseFile(config))
  try {
    ensureAuthSchema(db)
    const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
    const user = await service.setPassword(email, password)
    console.log(`Updated password for ${user.id} <${user.email}>; all sessions revoked.`)
    return user
  } finally {
    db.close()
  }
}

/**
 * SQLite's WAL relies on shared memory and POSIX locks. On WSL's drvfs mounts
 * and on network shares those are unreliable when more than one process opens
 * the file, which can make committed rows disappear. Warn, do not block: some
 * people do run this way successfully.
 */
function filesystemWarnings(databasePath: string): string[] {
  const warnings: string[] = []
  if (/^\/mnt\/[a-z]\//i.test(databasePath)) {
    warnings.push(
      'the database is on a WSL /mnt/<drive> mount. SQLite WAL is unreliable there; ' +
        'keep data on the Linux filesystem and run one server process per database.',
    )
  } else if (databasePath.startsWith('\\\\') || databasePath.startsWith('//')) {
    warnings.push(
      'the database is on a network share. SQLite WAL is unreliable there; use a local disk.',
    )
  }
  return warnings
}

/** Password sources shared by `user create` and `user passwd`. */
function passwordFromEnv(): string | undefined {
  const file = process.env.MUNGIL_USER_PASSWORD_FILE
  if (file) {
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {
      // Fall through to the plain variable.
    }
  }
  return process.env.MUNGIL_USER_PASSWORD
}

function passwordHelp(action: string): string {
  return (
    `Set MUNGIL_USER_PASSWORD to ${action} an account, or use ` +
    '`--password-stdin`, `--generate-password`, or MUNGIL_USER_PASSWORD_FILE=<path>. ' +
    'A `.env` file in the working directory is loaded automatically when it exists.'
  )
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

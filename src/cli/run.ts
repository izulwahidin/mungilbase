import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ConfigError } from '../config/load.js'
import { findConfigPath, loadConfig } from '../config/load.js'
import { MigrationError } from '../db/migrator.js'
import { SchemaError } from '../tables/registry.js'
import { AppError } from '../http/errors.js'
import { VERSION } from '../version.js'
import { startServer } from '../server.js'
import {
  backup,
  createUser,
  doctor,
  filesGc,
  gen,
  migrate,
  openapi,
  resetPassword,
  sdk,
  setRole,
} from './commands.js'
import { dev } from './dev.js'
import { init } from './init.js'
import { checkMcp } from '../mcp/check.js'
import { runMcpServer, applyMcpDefaults } from '../mcp/start.js'
import {
  MCP_CLIENTS,
  buildClientConfig,
  mergeClientConfig,
  type McpClient,
} from '../mcp/client-config.js'

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export interface CliIo {
  log(message: string): void
  error(message: string): void
}

interface ParsedArgs {
  positionals: string[]
  config?: string
  host?: string
  port?: number
  output?: string
  role?: string
  passwordEnv?: string
  user?: string
  tables?: string[]
  demoEmail?: string
  printConfig?: McpClient
  force: boolean
  json: boolean
  apply: boolean
  allowWrite: boolean
  admin: boolean
  allowRawSql: boolean
  demo: boolean
  check: boolean
  write: boolean
  passwordStdin: boolean
  generatePassword: boolean
  help: boolean
  version: boolean
}

const COMMANDS = new Set([
  'start',
  'serve',
  'dev',
  'init',
  'migrate',
  'mcp',
  'doctor',
  'check',
  'gen',
  'openapi',
  'sdk',
  'backup',
  'files',
  'files-gc',
  'user',
  'create-user',
  'passwd',
  'reset-password',
  'set-role',
  'help',
  'version',
])

const CONFIG_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']

/**
 * `npx mungilbase` has to work before a config exists, so parse errors and
 * startup errors are human-readable rather than stack traces. Set
 * `MUNGIL_DEBUG=1` when you want the original error object.
 */
export async function runCli(
  argv: string[],
  io: CliIo = { log: console.log, error: console.error },
): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`mungilbase: ${error.message}`)
      io.error('Run `mungilbase help` for usage.')
      return 2
    }
    throw error
  }

  if (parsed.version) {
    io.log(`mungilbase ${VERSION}`)
    return 0
  }
  if (parsed.help) {
    io.log(helpText())
    return 0
  }

  const [rawCommand, ...rest] = parsed.positionals
  let command: string
  try {
    command = normalizeCommand(rawCommand)
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`mungilbase: ${error.message}`)
      io.error('Run `mungilbase help` for usage.')
      return 2
    }
    throw error
  }
  if (command === 'start' && rawCommand && looksLikeConfigPath(rawCommand) && !parsed.config) {
    parsed.config = rawCommand
  }
  if (command === 'help') {
    io.log(helpText())
    return 0
  }
  if (command === 'version') {
    io.log(`mungilbase ${VERSION}`)
    return 0
  }

  try {
    await dispatch(command, rest, parsed, io)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(`mungilbase: ${error.message}`)
      io.error('Run `mungilbase help` for usage.')
      return 2
    }
    if (
      error instanceof ConfigError ||
      error instanceof SchemaError ||
      error instanceof MigrationError ||
      error instanceof AppError
    ) {
      io.error(`mungilbase: ${error.message}`)
      return 1
    }
    if (process.env.MUNGIL_DEBUG) {
      io.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    } else {
      io.error(`mungilbase: ${error instanceof Error ? error.message : String(error)}`)
      io.error('Set MUNGIL_DEBUG=1 to see the full stack trace.')
    }
    return 1
  }
}

async function dispatch(
  command: string,
  args: string[],
  parsed: ParsedArgs,
  io: CliIo,
): Promise<void> {
  const options = { configPath: parsed.config, version: VERSION }

  if (parsed.printConfig && command !== 'mcp') {
    throw new UsageError('--print-config only applies to the mcp command')
  }
  if (parsed.check && command !== 'mcp' && command !== 'gen') {
    throw new UsageError('--check only applies to the mcp and gen commands')
  }

  switch (command) {
    case 'start':
    case 'serve': {
      const configPath = args[0] ?? parsed.config
      await startServer({
        configPath,
        host: parsed.host,
        port: parsed.port,
        version: VERSION,
      })
      return
    }
    case 'dev':
      await dev({ configPath: parsed.config, host: parsed.host, port: parsed.port })
      return
    case 'init': {
      const result = await init({
        directory: args[0],
        force: parsed.force,
        json: parsed.json,
        demo: parsed.demo,
        demoEmail: parsed.demoEmail,
      })
      for (const path of result.created) io.log(`Created ${path}`)
      for (const path of result.skipped) io.log(`Kept    ${path} (already exists)`)
      io.log('')
      if (result.demo) {
        io.log('Demo data is ready:')
        io.log(`  Database  ${result.demo.database}`)
        io.log(`  Account   ${result.demo.email}`)
        io.log(`  Password  ${result.demo.password}`)
        io.log(`  Todos     ${result.demo.todos} rows (private to that account)`)
        io.log('')
        io.log('The password is shown once. Store it now, or run:')
        io.log(`  mungilbase user passwd ${result.demo.email} --generate-password`)
        io.log('')
      }
      io.log('Next:')
      if (!result.demo) io.log('  mungilbase migrate')
      io.log('  mungilbase start')
      io.log('')
      io.log('Frontend  http://localhost:8787')
      io.log('API       http://localhost:8787/api/v1')
      io.log('Admin     http://localhost:8787/admin  (first run creates the administrator)')
      io.log('MCP       mungilbase mcp --check')
      io.log('          mungilbase mcp --print-config opencode')
      if (!result.demo) {
        io.log('')
        io.log('No browser? MUNGIL_USER_PASSWORD=... mungilbase user create you@example.com --role admin')
      }
      return
    }
    case 'migrate':
      await migrate(options)
      return
    case 'mcp':
      if (parsed.printConfig) {
        await printClientConfig(parsed, parsed.printConfig, io)
        return
      }
      if (parsed.check) {
        const result = await checkMcp(
          {
            configPath: parsed.config,
            user: parsed.user,
            allowWrite: parsed.allowWrite,
            admin: parsed.admin,
            allowRawSql: parsed.allowRawSql,
            tables: parsed.tables,
            version: VERSION,
          },
          parsed.json ? () => undefined : io.log,
        )
        if (parsed.json) io.log(JSON.stringify(result, null, 2))
        return
      }
      await runMcpServer({
        configPath: parsed.config,
        user: parsed.user,
        allowWrite: parsed.allowWrite,
        admin: parsed.admin,
        allowRawSql: parsed.allowRawSql,
        tables: parsed.tables,
        version: VERSION,
      })
      return
    case 'doctor':
    case 'check':
      await doctor({ ...options, json: parsed.json })
      return
    case 'gen': {
      const result = await gen({ ...options, check: parsed.check })
      if (!parsed.check) return
      if (result.stale.length === 0) {
        io.log('Generated files are up to date.')
        return
      }
      for (const artifact of result.stale) io.error(`stale: ${artifact.path}`)
      throw new Error(`Generated files are stale. Run \`mungilbase gen\` to update them.`)
    }
    case 'openapi':
      await openapi({ ...options, output: args[0] ?? parsed.output })
      return
    case 'sdk':
      await sdk({ ...options, output: args[0] ?? parsed.output })
      return
    case 'backup':
      await backup({ ...options, destination: args[0] })
      return
    case 'files':
    case 'files-gc': {
      const apply = parsed.apply || args.includes('--apply')
      await filesGc({ ...options, apply })
      return
    }
    case 'user':
      return dispatchUser(args, parsed, options, io)
    case 'create-user': {
      const email = requireArg(args[0], 'user create needs an email address')
      await createAccount(email, parsed, options, io)
      return
    }
    case 'passwd':
    case 'reset-password': {
      const email = requireArg(args[0], 'user passwd needs an email address')
      await changePassword(email, parsed, options, io)
      return
    }
    case 'set-role': {
      const email = requireArg(args[0], 'user role needs an email address')
      const role = requireArg(args[1], 'user role needs a role (user or admin)')
      await setRole(email, role, options)
      return
    }
    default:
      throw new UsageError(`unknown command "${command}"`)
  }
}

async function dispatchUser(
  args: string[],
  parsed: ParsedArgs,
  options: { configPath?: string; version: string },
  io: CliIo,
): Promise<void> {
  const [subcommand, ...rest] = args
  switch (subcommand) {
    case 'create': {
      const email = requireArg(rest[0], 'user create needs an email address')
      await createAccount(email, parsed, options, io)
      return
    }
    case 'passwd':
    case 'password':
    case 'reset': {
      const email = requireArg(rest[0], 'user passwd needs an email address')
      await changePassword(email, parsed, options, io)
      return
    }
    case 'role': {
      const email = requireArg(rest[0], 'user role needs an email address')
      const role = requireArg(rest[1], 'user role needs a role (user or admin)')
      await setRole(email, role, options)
      return
    }
    default:
      throw new UsageError(
        subcommand
          ? `unknown user command "${subcommand}"`
          : 'missing user command (create, passwd or role)',
      )
  }
}

async function createAccount(
  email: string,
  parsed: ParsedArgs,
  options: { configPath?: string; version: string },
  io: CliIo,
): Promise<void> {
  const password = await resolvePassword(parsed)
  const user = await createUser(email, { ...options, password: password.value, role: parsed.role })
  reportPassword(password, io, user.email)
}

async function changePassword(
  email: string,
  parsed: ParsedArgs,
  options: { configPath?: string; version: string },
  io: CliIo,
): Promise<void> {
  const password = await resolvePassword(parsed)
  const user = await resetPassword(email, { ...options, password: password.value })
  reportPassword(password, io, user.email)
}

interface ResolvedPassword {
  value?: string
  generated: boolean
}

async function resolvePassword(parsed: ParsedArgs): Promise<ResolvedPassword> {
  if (parsed.generatePassword) {
    return { value: randomBytes(18).toString('base64url'), generated: true }
  }

  if (parsed.passwordStdin) {
    if (process.stdin.isTTY) {
      throw new UsageError(
        '--password-stdin expects the password on stdin, e.g. `printf %s "$PW" | mungilbase user create me@example.com --password-stdin`',
      )
    }
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
    if (!value) throw new UsageError('--password-stdin received an empty password')
    return { value, generated: false }
  }

  if (parsed.passwordEnv) {
    const value = process.env[parsed.passwordEnv]
    if (!value) throw new UsageError(`environment variable ${parsed.passwordEnv} is not set`)
    return { value, generated: false }
  }

  return { value: process.env.MUNGIL_USER_PASSWORD, generated: false }
}

function reportPassword(password: ResolvedPassword, io: CliIo, email: string): void {
  if (!password.generated || !password.value) return
  io.log('')
  io.log(`Password  ${password.value}`)
  io.log(`Account   ${email}`)
  io.log('Shown once. Store it now; it is not written anywhere.')
}

/** Emits a client configuration that launches the server without npx. */
async function printClientConfig(
  parsed: ParsedArgs,
  client: McpClient,
  io: CliIo,
): Promise<void> {
  const configPath = findConfigPath(parsed.config)
  const config = await loadConfig(configPath)
  const effective = applyMcpDefaults(
    {
      user: parsed.user,
      tables: parsed.tables,
      allowWrite: parsed.allowWrite,
      admin: parsed.admin,
      allowRawSql: parsed.allowRawSql,
    },
    config,
  )

  const cliPath = process.argv[1]
  if (!cliPath) throw new UsageError('cannot determine the mungilbase CLI path')

  const rendering = buildClientConfig({
    client,
    cliPath,
    configPath,
    cwd: dirname(configPath),
    user: effective.user,
    tables: effective.tables,
    allowWrite: effective.allowWrite,
    admin: effective.admin,
    allowRawSql: effective.allowRawSql,
  })

  if (!parsed.write) {
    io.log(JSON.stringify(rendering.document, null, 2))
    return
  }

  if (!rendering.path) {
    throw new UsageError('the raw client has no config file; print it instead of --write')
  }

  const merged = await mergeClientConfig(client, rendering.path, rendering.entry)
  await mkdir(dirname(rendering.path), { recursive: true })
  await writeFile(rendering.path, merged.raw, 'utf8')
  io.log(`${merged.created ? 'Created' : 'Updated'} ${rendering.path}`)
  io.log('Restart the client to pick up the new server.')
}

function requireArg(value: string | undefined, message: string): string {
  if (!value) throw new UsageError(message)
  return value
}

function normalizeCommand(raw: string | undefined): string {
  if (!raw) return 'start'

  // `mungilbase ./mungil.config.json` is treated as `start ./mungil.config.json`.
  if (!COMMANDS.has(raw) && looksLikeConfigPath(raw)) return 'start'
  if (!COMMANDS.has(raw)) throw new UsageError(`unknown command "${raw}"`)
  return raw
}

function looksLikeConfigPath(value: string): boolean {
  return CONFIG_EXTENSIONS.some((extension) => value.endsWith(extension)) || value.includes('/')
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    force: false,
    json: false,
    apply: false,
    allowWrite: false,
    admin: false,
    allowRawSql: false,
    demo: false,
    check: false,
    write: false,
    passwordStdin: false,
    generatePassword: false,
    help: false,
    version: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--') {
      parsed.positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      parsed.version = true
      continue
    }
    if (arg === '--force') {
      parsed.force = true
      continue
    }
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--apply') {
      parsed.apply = true
      continue
    }
    if (arg === '--allow-write') {
      parsed.allowWrite = true
      continue
    }
    if (arg === '--admin') {
      parsed.admin = true
      continue
    }
    if (arg === '--allow-raw-sql' || arg === '--allow-sql') {
      parsed.allowRawSql = true
      continue
    }
    if (arg === '--demo') {
      parsed.demo = true
      continue
    }
    if (arg === '--check') {
      parsed.check = true
      continue
    }
    if (arg === '--write') {
      parsed.write = true
      continue
    }
    if (arg === '--password-stdin') {
      parsed.passwordStdin = true
      continue
    }
    if (arg === '--generate-password') {
      parsed.generatePassword = true
      continue
    }
    if (arg === '--print-config') {
      const next = argv[index + 1]
      if (next && isMcpClient(next)) {
        parsed.printConfig = next
        index += 1
      } else if (!next || next.startsWith('-')) {
        parsed.printConfig = 'opencode'
      } else {
        throw new UsageError(
          `unknown client "${next}" for --print-config. Choose one of: ${MCP_CLIENTS.join(', ')}`,
        )
      }
      continue
    }

    const inline = splitFlag(arg)
    const flag = inline?.name ?? arg
    const inlineValue = inline?.value

    switch (flag) {
      case '--config':
      case '-c':
        parsed.config = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--host':
        parsed.host = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--port': {
        const value = takeValue(flag, inlineValue, argv, () => ++index)
        const port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new UsageError(`--port must be an integer between 1 and 65535, got "${value}"`)
        }
        parsed.port = port
        continue
      }
      case '--output':
      case '-o':
        parsed.output = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--role':
        parsed.role = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--password-env':
        parsed.passwordEnv = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--print-config': {
        const value = inlineValue
        if (!isMcpClient(value)) {
          throw new UsageError(
            `unknown client "${value}" for --print-config. Choose one of: ${MCP_CLIENTS.join(', ')}`,
          )
        }
        parsed.printConfig = value
        continue
      }
      case '--user':
        parsed.user = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--demo-email':
        parsed.demoEmail = takeValue(flag, inlineValue, argv, () => ++index)
        continue
      case '--tables': {
        const value = takeValue(flag, inlineValue, argv, () => ++index)
        const names = value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
        if (names.length === 0) throw new UsageError('--tables needs at least one table name')
        parsed.tables = names
        continue
      }
    }

    if (flag.startsWith('-')) throw new UsageError(`unknown option "${flag}"`)
    parsed.positionals.push(arg)
  }

  if (parsed.passwordStdin && parsed.generatePassword) {
    throw new UsageError('choose either --password-stdin or --generate-password')
  }

  return parsed
}

function isMcpClient(value: string | undefined): value is McpClient {
  return Boolean(value) && (MCP_CLIENTS as readonly string[]).includes(value as string)
}

function splitFlag(arg: string): { name: string; value: string } | undefined {
  if (!arg.startsWith('--')) return undefined
  const separator = arg.indexOf('=')
  if (separator === -1) return undefined
  return { name: arg.slice(0, separator), value: arg.slice(separator + 1) }
}

function takeValue(
  flag: string,
  inlineValue: string | undefined,
  argv: string[],
  next: () => number,
): string {
  if (inlineValue !== undefined) {
    if (inlineValue === '') throw new UsageError(`${flag} needs a value`)
    return inlineValue
  }
  const value = argv[next()]
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} needs a value`)
  }
  return value
}

export function helpText(): string {
  return `mungilbase ${VERSION} — a small, self-hosted backend defined by one config file

Usage
  mungilbase [command] [options]

Commands
  start                 Start the API server (default)
  dev                   Start, then restart and regenerate when the config changes
  init [dir]            Create a starter config, public/ page, .env.example and .gitignore
  migrate               Apply migrations and sync the schema
  mcp                   Serve the MCP tools for AI agents over stdio
  doctor                Validate the config and print a summary
  gen                   Write openapi.json and the TypeScript client
  openapi [file]        Write the OpenAPI 3.1 document (default ./openapi.json)
  sdk [file]            Generate the TypeScript client (default ./sdk/mungil-client.ts)
  backup [dir|file]     Take a verified online backup (default ./backups)
  files gc              Collect unreferenced uploads (dry run; --apply deletes)
  user create <email>   Create an account (--generate-password prints one once)
  user passwd <email>   Reset a password and revoke sessions
  user role <email> <role>
                        Change a role (user or admin)
  version               Print the CLI version
  help                  Show this help

Options
  -c, --config <path>   Config file (default: first mungil.config.* here)
      --host <host>     Listen address for start/dev
      --port <port>     Listen port for start/dev
  -o, --output <path>   Output path for openapi/sdk
      --role <role>     Role for user create (default: MUNGIL_USER_ROLE or user)
      --generate-password
                        user create/passwd: generate a password and print it once
      --password-stdin  user create/passwd: read the password from stdin
      --password-env <name>
                        user create/passwd: read the password from this env var
      --user <email>    mcp: evaluate rules as this account (default: config mcp.user)
      --tables <a,b>    mcp: expose only these tables
      --allow-write     mcp: register create/update/delete tools
      --admin           mcp: register schema, user, backup, audit tools
                        (requires --user with an admin account)
      --allow-raw-sql   mcp: expose query_sql and execute_sql (requires --admin)
      --check           mcp: exercise the server; gen: fail when files are stale
      --print-config [opencode|claude|cursor|vscode|raw]
                        mcp: print a ready-to-paste client configuration
      --write           mcp --print-config: update the client config file
      --demo            init: working todo example (migrate, seed, demo account)
      --demo-email <e>  init --demo: account email (default demo@example.com)
      --json            init: write mungil.config.json; doctor: JSON output
      --force           init: overwrite existing files
      --apply           files gc: actually delete objects
  -h, --help            Show this help
  -v, --version         Print the CLI version

Examples
  npx mungilbase init --demo
  npx mungilbase start
  npx mungilbase gen --check
  npx mungilbase user create me@example.com --generate-password
  npx mungilbase mcp --check
  npx mungilbase mcp --print-config opencode --write
  npx mungilbase mcp --user me@example.com --allow-write
  npx mungilbase mcp --user admin@example.com --admin --allow-raw-sql
`
}

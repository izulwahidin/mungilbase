import { ConfigError } from '../config/load.js'
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
  migrate,
  openapi,
  resetPassword,
  sdk,
  setRole,
} from './commands.js'
import { init } from './init.js'
import { runMcpServer } from '../mcp/start.js'

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
  force: boolean
  json: boolean
  apply: boolean
  allowWrite: boolean
  admin: boolean
  allowRawSql: boolean
  help: boolean
  version: boolean
}

const COMMANDS = new Set([
  'start',
  'serve',
  'init',
  'migrate',
  'mcp',
  'doctor',
  'check',
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
  const password = readPassword(parsed.passwordEnv)

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
    case 'init': {
      const result = await init({
        directory: args[0],
        force: parsed.force,
        json: parsed.json,
      })
      for (const path of result.created) io.log(`Created ${path}`)
      for (const path of result.skipped) io.log(`Kept    ${path} (already exists)`)
      io.log('')
      io.log('Next:')
      io.log('  mungilbase migrate')
      if (result.created.some((path) => path.endsWith('config.ts') || path.endsWith('config.json'))) {
        io.log('  MUNGIL_USER_PASSWORD=... mungilbase user create you@example.com')
      }
      io.log('  mungilbase start')
      return
    }
    case 'migrate':
      await migrate(options)
      return
    case 'mcp':
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
      await doctor(options)
      return
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
      return dispatchUser(args, parsed, options, password)
    case 'create-user': {
      const email = requireArg(args[0], 'user create needs an email address')
      await createUser(email, { ...options, password, role: parsed.role })
      return
    }
    case 'passwd':
    case 'reset-password': {
      const email = requireArg(args[0], 'user passwd needs an email address')
      await resetPassword(email, { ...options, password })
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
  password: string | undefined,
): Promise<void> {
  const [subcommand, ...rest] = args
  switch (subcommand) {
    case 'create': {
      const email = requireArg(rest[0], 'user create needs an email address')
      await createUser(email, { ...options, password, role: parsed.role })
      return
    }
    case 'passwd':
    case 'password':
    case 'reset': {
      const email = requireArg(rest[0], 'user passwd needs an email address')
      await resetPassword(email, { ...options, password })
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

function readPassword(passwordEnv?: string): string | undefined {
  if (passwordEnv) {
    const value = process.env[passwordEnv]
    if (!value) throw new UsageError(`environment variable ${passwordEnv} is not set`)
    return value
  }
  return process.env.MUNGIL_USER_PASSWORD
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
      case '--user':
        parsed.user = takeValue(flag, inlineValue, argv, () => ++index)
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

  return parsed
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
  init [dir]            Create a starter config, .env.example and .gitignore
  migrate               Apply migrations and sync the schema
  mcp                   Serve the MCP tools for AI agents over stdio
  doctor                Validate the config and print a summary
  openapi [file]        Write the OpenAPI 3.1 document (default ./openapi.json)
  sdk [file]            Generate the TypeScript client (default ./sdk/mungil-client.ts)
  backup [dir|file]     Take a verified online backup (default ./backups)
  files gc              Collect unreferenced uploads (dry run; --apply deletes)
  user create <email>   Create an account (MUNGIL_USER_PASSWORD)
  user passwd <email>   Reset a password and revoke sessions
  user role <email> <role>
                        Change a role (user or admin)
  version               Print the CLI version
  help                  Show this help

Options
  -c, --config <path>   Config file (default: first mungil.config.* here)
      --host <host>     Listen address for start
      --port <port>     Listen port for start
  -o, --output <path>   Output path for openapi/sdk
      --role <role>     Role for user create (default: MUNGIL_USER_ROLE or user)
      --user <email>    mcp: evaluate rules as this account (default: anonymous)
      --tables <a,b>    mcp: expose only these tables
      --allow-write     mcp: register create/update/delete tools
      --admin           mcp: register schema, user, backup, audit tools
                        (requires --user with an admin account)
      --allow-raw-sql   mcp: expose query_sql and execute_sql (requires --admin)
      --password-env <name>
                        Read the password from this env var
      --json            init: write mungil.config.json instead of .ts
      --force           init: overwrite existing files
      --apply           files gc: actually delete objects
  -h, --help            Show this help
  -v, --version         Print the CLI version

Examples
  npx mungilbase init
  npx mungilbase migrate
  MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create me@example.com
  npx mungilbase start --port 8787
  npx mungilbase mcp --user me@example.com --allow-write
  npx mungilbase mcp --user admin@example.com --admin --allow-raw-sql
  npx mungilbase sdk ./src/lib/mungil.ts
`
}

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface EnvFileStatus {
  /** Resolved path, or null when no env file was found or requested. */
  path: string | null
  /** True when the file was found and handed to Node's loader. */
  loaded: boolean
  /** Set when an explicitly requested file could not be loaded. */
  error?: string
  /** True when the path came from `--env-file` or `MUNGIL_ENV_FILE`. */
  explicit: boolean
}

/**
 * Finds the env file for a CLI invocation.
 *
 * Order: `--env-file <path>`, `MUNGIL_ENV_FILE`, then `./.env`. Values already
 * present in the real environment always win (Node's `loadEnvFile` only fills
 * in missing variables), so a shell export beats the file.
 */
export function resolveEnvFile(argv: readonly string[] = [], cwd = process.cwd()): EnvFileStatus {
  const fromFlag = flagValue(argv, '--env-file')
  const explicit = fromFlag ?? process.env.MUNGIL_ENV_FILE ?? null

  if (explicit) {
    const path = resolve(cwd, explicit)
    return { path, loaded: false, explicit: true, ...(existsSync(path) ? {} : { error: 'not found' }) }
  }

  const path = resolve(cwd, '.env')
  return { path, loaded: false, explicit: false, ...(existsSync(path) ? {} : { path: null }) }
}

/**
 * Loads the env file into `process.env` without overriding existing values.
 * Failures are returned, never thrown: a malformed .env must not stop the CLI
 * from explaining what is wrong.
 */
export function loadEnv(
  argv: readonly string[] = [],
  cwd = process.cwd(),
): EnvFileStatus {
  const status = resolveEnvFile(argv, cwd)
  if (!status.path) return status
  if (status.error) return status

  try {
    process.loadEnvFile(status.path)
    return { ...status, loaded: true }
  } catch (error) {
    return {
      ...status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === flag) return argv[index + 1]
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return undefined
}

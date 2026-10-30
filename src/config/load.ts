import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configSchema, type MungilConfig } from './schema.js'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/** Files searched, in order, when no config path is given. */
export const CONFIG_CANDIDATES = [
  'mungil.config.ts',
  'mungil.config.mts',
  'mungil.config.js',
  'mungil.config.mjs',
  'mungil.config.cjs',
  'mungil.config.json',
] as const

/**
 * Resolves the config path used by the CLI and the server.
 *
 * Precedence: explicit argument, `MUNGIL_CONFIG`, then the first
 * `mungil.config.*` in the working directory. Failing here with a clear
 * message beats a module-not-found stack trace on a fresh install.
 */
export function findConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit)

  const fromEnv = process.env.MUNGIL_CONFIG
  if (fromEnv) return resolve(fromEnv)

  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(candidate)
    if (existsSync(path)) return path
  }

  throw new ConfigError(
    `No config file found in ${process.cwd()}. Create one with \`npx mungilbase init\` ` +
      `or pass --config <path>.`,
  )
}

/**
 * Loads a config from a `.json` file or a JS/TS module with a default export.
 *
 * JSON is supported so a production container can mount a config without a
 * build step. TypeScript configs are loaded through `tsx`'s in-process API, so
 * `npx mungilbase` works without a separate build step or `tsx` CLI.
 */
export async function loadConfig(file?: string): Promise<MungilConfig> {
  const absolutePath = findConfigPath(file)

  if (!existsSync(absolutePath)) {
    throw new ConfigError(`Config file not found: ${absolutePath}`)
  }

  let raw: unknown

  try {
    if (extname(absolutePath) === '.json') {
      raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown
    } else if (isTypeScript(absolutePath)) {
      const { tsImport } = await import('tsx/esm/api')
      const module = (await tsImport(pathToFileURL(absolutePath).href, import.meta.url)) as {
        default?: unknown
      }
      raw = unwrapDefault(module)
    } else {
      const module = (await import(pathToFileURL(absolutePath).href)) as { default?: unknown }
      raw = unwrapDefault(module)
    }
  } catch (error) {
    throw new ConfigError(
      `Failed to load config from ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  if (raw === undefined || raw === null) {
    throw new ConfigError(`Config ${absolutePath} must export a default object`)
  }

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid config in ${absolutePath}:\n${issues}`)
  }

  return parsed.data
}

function isTypeScript(file: string): boolean {
  const extension = extname(file)
  return extension === '.ts' || extension === '.mts' || extension === '.cts'
}

/**
 * Test runners and some bundlers wrap a dynamic import in an extra namespace
 * object. Unwrapping only an object whose single key is `default` is safe:
 * a config root cannot contain a `default` key (the schema is strict).
 */
function unwrapDefault(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < 2; depth += 1) {
    if (
      current !== null &&
      typeof current === 'object' &&
      'default' in current &&
      Object.keys(current).length === 1
    ) {
      current = (current as { default: unknown }).default
    }
  }
  return current
}

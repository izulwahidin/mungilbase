import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configSchema, type MungilConfig, type MungilConfigInput } from './schema.js'

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

export interface LoadedConfig {
  /** Absolute path of the file that was loaded. */
  path: string
  /** Validated config with defaults applied and relative paths resolved. */
  config: MungilConfig
  /**
   * What the file itself contained, before defaults and path resolution.
   * The admin panel edits this and writes it back, so values the operator did
   * not write stay out of the file.
   */
  raw: MungilConfigInput
}

/**
 * Loads a config from a `.json` file or a JS/TS module with a default export.
 *
 * JSON is supported so a production container can mount a config without a
 * build step. TypeScript configs are loaded through `tsx`'s in-process API, so
 * `npx mungilbase` works without a separate build step or `tsx` CLI.
 */
export async function loadConfig(file?: string): Promise<MungilConfig> {
  return (await loadConfigFile(file)).config
}

/** Like `loadConfig`, but also reports the path and the file's own contents. */
export async function loadConfigFile(file?: string): Promise<LoadedConfig> {
  const absolutePath = findConfigPath(file)

  if (!existsSync(absolutePath)) {
    throw new ConfigError(`Config file not found: ${absolutePath}`)
  }

  let raw: unknown

  try {
    if (extname(absolutePath) === '.json') {
      raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown
    } else {
      // Native `import()` caches by URL, which would hide a config file that
      // the admin panel just rewrote. The mtime makes a changed file a new
      // module while an unchanged one is still reused.
      const version = statSync(absolutePath).mtimeMs
      const module = (await import(`${pathToFileURL(absolutePath).href}?v=${version}`)) as {
        default?: unknown
      }
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

  return {
    path: absolutePath,
    config: resolveRelativePaths(parsed.data, dirname(absolutePath)),
    raw: raw as MungilConfigInput,
  }
}

/**
 * Relative paths in the config (`database.file`, `storage.local.dir`,
 * `static.dir`) are resolved against the config file, not the process working
 * directory. A client that launches `mungilbase mcp` from another directory
 * then still opens the same database instead of silently creating a new one.
 */
function resolveRelativePaths(config: MungilConfig, base: string): MungilConfig {
  const resolveOne = (value: string): string =>
    value === ':memory:' || isAbsolute(value) ? value : resolve(base, value)

  return {
    ...config,
    database: { ...config.database, file: resolveOne(config.database.file) },
    ...(config.storage?.local
      ? { storage: { ...config.storage, local: { ...config.storage.local, dir: resolveOne(config.storage.local.dir) } } }
      : {}),
    ...(config.static ? { static: { ...config.static, dir: resolveOne(config.static.dir) } } : {}),
  }
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

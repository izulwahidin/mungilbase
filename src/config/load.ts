import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configSchema, type MungilConfig } from './schema.js'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Loads a config from a `.json` file or a JS/TS module with a default export.
 *
 * JSON is supported so a production container can mount a config without a
 * build step. TypeScript configs are for development and migration tooling.
 */
export async function loadConfig(file: string): Promise<MungilConfig> {
  const absolutePath = resolve(file)
  let raw: unknown

  try {
    if (extname(absolutePath) === '.json') {
      raw = JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown
    } else {
      const module = (await import(pathToFileURL(absolutePath).href)) as { default?: unknown }
      raw = module.default
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

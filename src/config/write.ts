import { copyFile, rename, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { configSchema, type MungilConfigInput } from './schema.js'

export type ConfigFormat = 'ts' | 'esm' | 'cjs' | 'json'

export class ConfigWriteError extends Error {
  override readonly name = 'ConfigWriteError'
}

/** How a config file at this path should be re-rendered. */
export function configFormat(path: string): ConfigFormat {
  switch (extname(path)) {
    case '.json':
      return 'json'
    case '.cjs':
      return 'cjs'
    case '.js':
    case '.mjs':
    case '.ts':
    case '.mts':
    case '.cts':
      return 'esm'
    default:
      throw new ConfigWriteError(
        `Cannot write a config with extension "${extname(path) || '(none)'}". ` +
          'Use .ts, .mts, .cts, .js, .mjs, .cjs or .json.',
      )
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function stringLiteral(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}'`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entriesOf(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([, entry]) => entry !== undefined)
}

/**
 * Renders a value on one line, or returns null when it needs indentation.
 * Keeping short field objects inline makes the generated file readable and
 * keeps diffs small.
 */
function renderInline(value: unknown): string | null {
  if (value === null) return 'null'
  if (typeof value === 'string') return stringLiteral(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ConfigWriteError('Config numbers must be finite')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const parts = value.map(renderInline)
    if (parts.some((part) => part === null)) return null
    const joined = `[${parts.join(', ')}]`
    return joined.length <= 80 ? joined : null
  }
  if (isPlainObject(value)) {
    const entries = entriesOf(value)
    if (entries.length === 0) return '{}'
    const parts = entries.map(([key, entry]) => {
      const rendered = renderInline(entry)
      return rendered === null ? null : `${IDENTIFIER.test(key) ? key : stringLiteral(key)}: ${rendered}`
    })
    if (parts.some((part) => part === null)) return null
    const joined = `{ ${parts.join(', ')} }`
    return joined.length <= 80 ? joined : null
  }
  throw new ConfigWriteError(`Cannot serialize a ${typeof value} in the config`)
}

function renderValue(value: unknown, indent: number): string {
  if (value === null || typeof value !== 'object') {
    const inline = renderInline(value)
    if (inline === null) throw new ConfigWriteError(`Cannot serialize ${typeof value} in the config`)
    return inline
  }

  const inline = renderInline(value)
  if (inline !== null) return inline

  const pad = '  '.repeat(indent + 1)
  const closing = '  '.repeat(indent)

  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}${renderValue(item, indent + 1)}`).join(',\n')
    return `[\n${items},\n${closing}]`
  }

  const entries = entriesOf(value as Record<string, unknown>)
  const items = entries
    .map(([key, entry]) => `${pad}${IDENTIFIER.test(key) ? key : stringLiteral(key)}: ${renderValue(entry, indent + 1)}`)
    .join(',\n')
  return `{\n${items},\n${closing}}`
}

const HEADER = `/**
 * MungilBase config: the source of truth for this server.
 *
 * Saving a table in the admin panel (/admin/schema) rewrites this file and
 * keeps the previous version next to it with a ".bak" suffix. Anything that
 * is not plain data (functions, process.env lookups) becomes the value it had
 * when the file was written, so review the diff before deploying.
 *
 * Keep this file in version control.
 */`

const FIELD_DEFAULTS = {
  required: false,
  unique: false,
  maxBytes: 5_000_000,
  allowedTypes: ['image/'],
} as const

/**
 * Drops keys whose value is already the schema default. The file stays valid
 * (the schema puts them back), but a generated config reads like a hand-written
 * one instead of repeating `required: false` on every field.
 */
function minimizeTable(table: unknown): unknown {
  if (!isPlainObject(table)) return table

  const out: Record<string, unknown> = { ...table }
  if (out.timestamps === true) delete out.timestamps
  if (Array.isArray(out.indexes) && out.indexes.length === 0) delete out.indexes

  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map((field) => {
      if (!isPlainObject(field)) return field
      const copy: Record<string, unknown> = { ...field }
      for (const [key, fallback] of Object.entries(FIELD_DEFAULTS)) {
        const current = copy[key]
        const isDefault = Array.isArray(fallback)
          ? Array.isArray(current) && current.length === fallback.length && current.every((entry, index) => entry === fallback[index])
          : current === fallback
        if (isDefault) delete copy[key]
      }
      return copy
    })
  }

  return out
}

export function renderConfigSource(input: MungilConfigInput, format: ConfigFormat): string {
  // Never write a file the server would refuse to boot with.
  configSchema.parse(input)

  const normalized: MungilConfigInput = Array.isArray(input.tables)
    ? ({ ...input, tables: input.tables.map(minimizeTable) } as MungilConfigInput)
    : input

  if (format === 'json') {
    return `${JSON.stringify(normalized, null, 2)}\n`
  }

  const body = renderValue(normalized, 0)
  const exportStatement = format === 'cjs' ? `module.exports = ${body}` : `export default ${body}`
  return `${HEADER}\n${exportStatement}\n`
}

export interface WriteConfigResult {
  /** Path of the previous version, when one existed. */
  backup: string | null
  format: ConfigFormat
}

/**
 * Rewrites a config file in place.
 *
 * The old file is copied to `<path>.bak` first and the new content is written
 * to a temporary file in the same directory before the rename, so a crash
 * leaves either the old file or the new one, never half of each.
 */
export async function writeConfigFile(
  path: string,
  input: MungilConfigInput,
): Promise<WriteConfigResult> {
  const format = configFormat(path)
  const source = renderConfigSource(input, format)

  let backup: string | null = null
  try {
    await copyFile(path, `${path}.bak`)
    backup = `${path}.bak`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, source, 'utf8')
  await rename(temporary, path)

  return { backup, format }
}

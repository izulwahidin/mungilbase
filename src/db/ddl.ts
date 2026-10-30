import type { Db } from './connect.js'
import { transaction } from './tx.js'
import type { FieldConfig, TableConfig } from '../config/schema.js'
import { SchemaError, type Registry } from '../tables/registry.js'

const SQL_TYPES = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  json: 'TEXT',
  date: 'TEXT',
  file: 'TEXT',
} as const

const TIMESTAMP_DEFAULT = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

export interface IndexDdl {
  name: string
  sql: string
}

export interface TableDdl {
  create: string
  indexes: IndexDdl[]
}

export function quote(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new SchemaError(`Invalid identifier "${name}"`)
  return `"${name}"`
}

function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SchemaError('Default values must be finite numbers')
    return String(value)
  }
  return `'${value.replaceAll("'", "''")}'`
}

function columnDefinition(field: FieldConfig, options: { forAlter: boolean }): string {
  const type = SQL_TYPES[field.type]
  const parts = [quote(field.name), type]

  // A default is a value the column always has. Making it NOT NULL keeps the
  // generated types honest: `done` is a boolean, not boolean | null.
  const nonNull = field.required || (field.default !== undefined && field.default !== null)
  if (nonNull) parts.push('NOT NULL')

  if (field.unique) {
    // SQLite cannot add a UNIQUE column with ALTER TABLE. Refuse early with a
    // useful message instead of failing halfway through a deployment.
    if (options.forAlter) {
      throw new SchemaError(
        `Cannot add unique column "${field.name}" to an existing table. ` +
          `Add it nullable or write a migration.`,
      )
    }
    parts.push('UNIQUE')
  }

  if (field.default !== undefined) parts.push(`DEFAULT ${sqlLiteral(field.default)}`)

  if (field.references) {
    parts.push(`REFERENCES ${quote(field.references.table)} (${quote(field.references.column)}) ON DELETE RESTRICT`)
  }

  if (field.type === 'boolean') parts.push(`CHECK (${quote(field.name)} IN (0, 1))`)
  if (field.type === 'json') parts.push(`CHECK (${quote(field.name)} IS NULL OR json_valid(${quote(field.name)}))`)

  return parts.join(' ')
}

function timestampColumn(name: 'created_at' | 'updated_at'): string {
  return `${quote(name)} TEXT NOT NULL DEFAULT ${TIMESTAMP_DEFAULT}`
}

export function columnType(fieldType: FieldConfig['type']): string {
  return SQL_TYPES[fieldType]
}

/** Deterministic DDL for a table. Same config in, same string out. */
export function tableDdl(table: TableConfig): TableDdl {
  const columns: string[] = [
    `${quote('id')} TEXT PRIMARY KEY NOT NULL`,
    ...[...table.fields].map((field) => columnDefinition(field, { forAlter: false })),
  ]

  if (table.timestamps) {
    columns.push(timestampColumn('created_at'), timestampColumn('updated_at'))
  }

  const indexes: IndexDdl[] = []
  const seen = new Set<string>()

  const addIndex = (columns: string[]): void => {
    const name = `idx_${table.name}_${columns.join('_')}`
    if (seen.has(name)) return
    seen.add(name)
    indexes.push({
      name,
      sql:
        `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(table.name)} ` +
        `(${columns.map(quote).join(', ')})`,
    })
  }

  for (const field of table.fields) {
    if (field.references) addIndex([field.name])
  }

  // Default listing is newest-first, so this index is on the hot path.
  if (table.timestamps) addIndex(['created_at'])

  for (const entry of table.indexes) {
    addIndex(Array.isArray(entry) ? entry : [entry])
  }

  return {
    create: `CREATE TABLE ${quote(table.name)} (\n  ${columns.join(',\n  ')}\n)`,
    indexes,
  }
}

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
}

export interface SchemaResult {
  created: string[]
  altered: { table: string; columns: string[] }[]
}

/**
 * Brings the database up to the config.
 *
 * Additive and safe:
 * - missing tables are created;
 * - missing nullable (or defaulted) columns are added;
 * - anything destructive or ambiguous fails at boot with a message telling the
 *   operator to write a migration.
 *
 * Renames are indistinguishable from drop+add, so they are always manual. That
 * is intentional: silently dropping a column with data is worse than a loud
 * startup error.
 */
export function ensureSchema(db: Db, registry: Registry): SchemaResult {
  return transaction(db, () => {
    const created: string[] = []
    const altered: { table: string; columns: string[] }[] = []

    const existing = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (row) => row.name,
      ),
    )

    for (const table of registry.tables.values()) {
      const ddl = tableDdl(table.config)

      if (!existing.has(table.name)) {
        db.exec(ddl.create)
        for (const index of ddl.indexes) db.exec(index.sql)
        created.push(table.name)
        continue
      }

      const info = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as ColumnInfo[]
      const existingColumns = new Map(info.map((column) => [column.name, column.type.toUpperCase()]))

      const desired = new Map<string, string>([['id', 'TEXT']])
      for (const field of table.config.fields) desired.set(field.name, columnType(field.type))
      if (table.config.timestamps) {
        desired.set('created_at', 'TEXT')
        desired.set('updated_at', 'TEXT')
      }

      const extra = [...existingColumns.keys()].filter((column) => !desired.has(column))
      if (extra.length) {
        throw new SchemaError(
          `Table "${table.name}" has column(s) ${extra.map((c) => `"${c}"`).join(', ')} that are not in the config. ` +
            `Removing columns is a migration, not a config change.`,
        )
      }

      const missing: FieldConfig[] = []
      for (const field of table.config.fields) {
        const actual = existingColumns.get(field.name)
        if (actual === undefined) {
          missing.push(field)
          continue
        }
        const expected = columnType(field.type)
        if (actual !== expected) {
          throw new SchemaError(
            `Column "${table.name}.${field.name}" is ${actual} in the database but ${expected} in the config. ` +
              `Write a migration to change its type.`,
          )
        }
      }

      const added: string[] = []
      for (const field of missing) {
        if (field.unique) {
          throw new SchemaError(
            `Cannot add unique column "${table.name}.${field.name}" to an existing table. Write a migration.`,
          )
        }
        if (field.required && field.default === undefined) {
          throw new SchemaError(
            `Cannot add required column "${table.name}.${field.name}" without a default. ` +
              `Add a default or write a migration to backfill it.`,
          )
        }
        db.exec(`ALTER TABLE ${quote(table.name)} ADD COLUMN ${columnDefinition(field, { forAlter: true })}`)
        added.push(field.name)
      }

      // Removing an index from the config is a migration, like removing a
      // column: the app never drops an index on its own.
      const managedPrefix = `idx_${table.name}_`
      const desiredIndexes = new Set(ddl.indexes.map((index) => index.name))
      const existingIndexes = db
        .prepare(`PRAGMA index_list(${quote(table.name)})`)
        .all() as { name: string }[]
      const dropped = existingIndexes
        .map((index) => index.name)
        .filter((name) => name.startsWith(managedPrefix) && !desiredIndexes.has(name))
      if (dropped.length) {
        throw new SchemaError(
          `Table "${table.name}" has index(es) ${dropped.map((name) => `"${name}"`).join(', ')} ` +
            `that are not in the config. Removing an index is a migration, not a config change.`,
        )
      }

      // Idempotent: also backfills indexes for tables created by an older
      // version, including the default listing index.
      for (const index of ddl.indexes) db.exec(index.sql)

      if (added.length) altered.push({ table: table.name, columns: added })
    }

    return { created, altered }
  })
}

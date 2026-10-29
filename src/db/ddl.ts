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
} as const

const TIMESTAMP_DEFAULT = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

export interface TableDdl {
  create: string
  indexes: string[]
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

  if (field.required) parts.push('NOT NULL')

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

  const indexes = table.fields
    .filter((field) => field.references)
    .map(
      (field) =>
        `CREATE INDEX IF NOT EXISTS ${quote(`idx_${table.name}_${field.name}`)} ` +
        `ON ${quote(table.name)} (${quote(field.name)})`,
    )

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
        for (const index of ddl.indexes) db.exec(index)
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

      // New index for a newly added foreign key (missing field or existing field
      // whose index was never created).
      const referenced = new Set(missing.map((field) => field.name))
      for (const index of ddl.indexes) {
        const usesNewColumn = [...referenced].some((column) => index.includes(quote(column)))
        if (usesNewColumn) db.exec(index)
      }

      if (added.length) altered.push({ table: table.name, columns: added })
    }

    return { created, altered }
  })
}

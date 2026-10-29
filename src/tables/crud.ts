import { randomUUID } from 'node:crypto'
import type { Db } from '../db/connect.js'
import { quote } from '../db/ddl.js'
import { compileRule, RuleError, type CompiledRule, type SqlValue } from '../sql/expr/index.js'
import { AppError, badRequest, conflict, notFound, ruleViolation } from '../http/errors.js'
import type { AuthContext } from '../auth/context.js'
import type { Operation, RegisteredTable } from './registry.js'
import { createValues, InputError, rowToApi, updateValues, type StoredValue } from './values.js'

type BindValue = string | number | null
type Row = Record<string, unknown>

export interface ListOptions {
  filter?: string
  sort?: string
  limit?: number
  offset?: number
}

export interface ListResult {
  items: Row[]
  limit: number
  offset: number
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/**
 * Compiles a rule for one request.
 *
 * `null` means "deny everyone" and is handled by each operation explicitly;
 * there is no code path where a missing rule becomes an allow.
 */
function ruleFor(table: RegisteredTable, operation: Operation, auth: AuthContext): CompiledRule | null {
  // Set by the HTTP layer only when the user is an admin AND the operator
  // enabled `auth.adminBypassRules`. Never inferred from a token claim.
  if (auth.admin === true) return { sql: '1', params: [] }

  const rule = table.rules[operation]
  if (rule === null) return null
  return compileRule(rule, { table: table.name, columns: table.columns, auth })
}

/** better-sqlite3 cannot bind booleans; rule literals can be boolean. */
function bind(params: SqlValue[]): BindValue[] {
  return params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value))
}

export function listRows(db: Db, table: RegisteredTable, auth: AuthContext, options: ListOptions = {}): ListResult {
  const limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit
  const offset = options.offset ?? 0

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest('offset must be a non-negative integer')
  }

  const sort = parseSort(table, options.sort)
  const filter = compileClientFilter(table, auth, options.filter)

  const rule = ruleFor(table, 'list', auth)
  if (!rule) return { items: [], limit, offset }

  const where = [`(${rule.sql})`]
  const params: SqlValue[] = [...rule.params]

  if (filter) {
    where.push(`(${filter.sql})`)
    params.push(...filter.params)
  }

  const sql =
    `SELECT * FROM ${quote(table.name)} WHERE ${where.join(' AND ')} ` +
    `ORDER BY ${sort} LIMIT ? OFFSET ?`

  const rows = db
    .prepare(sql)
    .all(...bind(params), limit, offset) as Row[]

  return { items: rows.map((row) => rowToApi(table, row)), limit, offset }
}

export function viewRow(db: Db, table: RegisteredTable, auth: AuthContext, id: string): Row {
  const rule = ruleFor(table, 'view', auth)
  const row = rule
    ? (db
        .prepare(`SELECT * FROM ${quote(table.name)} WHERE ${quote('id')} = ? AND (${rule.sql})`)
        .get(id, ...bind(rule.params)) as Row | undefined)
    : undefined

  if (!row) throw notFound(`${table.name} not found`)
  return rowToApi(table, row)
}

export function createRow(db: Db, table: RegisteredTable, auth: AuthContext, input: unknown): Row {
  const values = parseInput(() => createValues(table, input))
  const rule = ruleFor(table, 'create', auth)

  if (!rule) throw ruleViolation(`Creating ${table.name} is not allowed`)

  const now = new Date().toISOString()
  const all: Record<string, StoredValue> = { id: randomUUID(), ...values }
  if (table.config.timestamps) {
    all.created_at = now
    all.updated_at = now
  }

  const columns = Object.keys(all)
  const columnList = columns.map(quote).join(', ')
  const placeholders = columns.map(() => '?').join(', ')

  // The CTE + WHERE is the whole security model for inserts: if the rule is
  // false, the SELECT yields no rows, nothing is inserted, and RETURNING is
  // empty. No row back means denied, never "silently created".
  const sql =
    `WITH ${quote('new')} (${columnList}) AS (SELECT ${placeholders}) ` +
    `INSERT INTO ${quote(table.name)} (${columnList}) ` +
    `SELECT ${columnList} FROM ${quote('new')} WHERE (${rule.sql}) ` +
    `RETURNING *`

  const params = [...columns.map((column) => all[column] as StoredValue), ...rule.params]

  let row: Row | undefined
  try {
    row = db.prepare(sql).get(...bind(params)) as Row | undefined
  } catch (error) {
    throw mapSqliteError(error)
  }

  if (!row) throw ruleViolation(`Creating ${table.name} is not allowed`)
  return rowToApi(table, row)
}

export function updateRow(
  db: Db,
  table: RegisteredTable,
  auth: AuthContext,
  id: string,
  input: unknown,
): Row {
  const values = parseInput(() => updateValues(table, input))
  const rule = ruleFor(table, 'update', auth)

  const sets: Record<string, StoredValue> = { ...values }
  if (table.config.timestamps) sets.updated_at = new Date().toISOString()

  const columns = Object.keys(sets)
  const assignments = columns.map((column) => `${quote(column)} = ?`).join(', ')

  // Rule null compiles to no query at all; skip straight to the denial check.
  const sql = rule
    ? `UPDATE ${quote(table.name)} SET ${assignments} WHERE ${quote('id')} = ? AND (${rule.sql}) RETURNING *`
    : null

  let row: Row | undefined
  if (sql) {
    const params: SqlValue[] = [...columns.map((column) => sets[column] as StoredValue), id, ...rule!.params]
    try {
      row = db.prepare(sql).get(...bind(params)) as Row | undefined
    } catch (error) {
      throw mapSqliteError(error)
    }
  }

  if (row) return rowToApi(table, row)

  // Distinguish "not allowed" from "not found" using the view rule, never by
  // revealing whether the row exists to someone who cannot see it.
  if (isVisible(db, table, auth, id)) throw ruleViolation(`Updating ${table.name} is not allowed`)
  throw notFound(`${table.name} not found`)
}

export function deleteRow(db: Db, table: RegisteredTable, auth: AuthContext, id: string): Row {
  const rule = ruleFor(table, 'delete', auth)

  const sql = rule
    ? `DELETE FROM ${quote(table.name)} WHERE ${quote('id')} = ? AND (${rule.sql}) RETURNING *`
    : null

  let row: Row | undefined
  if (sql) {
    try {
      row = db.prepare(sql).get(id, ...bind(rule!.params)) as Row | undefined
    } catch (error) {
      throw mapSqliteError(error)
    }
  }

  if (row) return rowToApi(table, row)
  if (isVisible(db, table, auth, id)) throw ruleViolation(`Deleting ${table.name} is not allowed`)
  throw notFound(`${table.name} not found`)
}

function isVisible(db: Db, table: RegisteredTable, auth: AuthContext, id: string): boolean {
  const rule = ruleFor(table, 'view', auth)
  if (!rule) return false
  const row = db
    .prepare(`SELECT 1 AS ok FROM ${quote(table.name)} WHERE ${quote('id')} = ? AND (${rule.sql})`)
    .get(id, ...bind(rule.params)) as { ok: number } | undefined
  return row !== undefined
}

function parseSort(table: RegisteredTable, sort: string | undefined): string {
  if (!sort) {
    // Newest first, with rowid as a tie-breaker so rows created in the same
    // millisecond still come back in insertion order.
    return table.config.timestamps ? `${quote('created_at')} DESC, rowid DESC` : `rowid DESC`
  }

  const descending = sort.startsWith('-')
  const column = descending ? sort.slice(1) : sort

  if (!table.columns.has(column)) throw badRequest(`Cannot sort by unknown column "${column}"`)

  return `${quote(column)} ${descending ? 'DESC' : 'ASC'}, ${quote('id')} ASC`
}

function compileClientFilter(
  table: RegisteredTable,
  auth: AuthContext,
  filter: string | undefined,
): CompiledRule | null {
  if (!filter) return null
  try {
    return compileRule(filter, { table: table.name, columns: table.columns, auth })
  } catch (error) {
    if (error instanceof RuleError) throw badRequest(`Invalid filter: ${error.message}`)
    throw error
  }
}

function parseInput<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof InputError) throw badRequest('Invalid input', error.issues)
    throw error
  }
}

function mapSqliteError(error: unknown): AppError {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
  const message = error instanceof Error ? error.message : String(error)

  switch (code) {
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY':
      return conflict('A record with that value already exists', { constraint: message })
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
      return badRequest('Referenced record does not exist')
    case 'SQLITE_CONSTRAINT_NOTNULL':
      return badRequest('A required value is missing')
    case 'SQLITE_CONSTRAINT_CHECK':
      return badRequest('A value failed a column check')
    default:
      throw error
  }
}

import type { FieldConfig } from '../config/schema.js'
import type { RegisteredTable } from './registry.js'

/** How values are stored in SQLite. JSON is text, booleans are 0/1. */
export type StoredValue = string | number | null

export interface FieldIssue {
  field: string
  message: string
}

export class InputError extends Error {
  override readonly name = 'InputError'
  readonly issues: FieldIssue[]

  constructor(issues: FieldIssue[]) {
    super('Invalid input')
    this.issues = issues
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates a create body and fills defaults.
 *
 * Unknown keys are rejected rather than ignored: a typo like `publised: true`
 * should fail loudly, not silently create an unpublished row.
 */
export function createValues(table: RegisteredTable, input: unknown): Record<string, StoredValue> {
  if (!isPlainObject(input)) throw new InputError([{ field: '', message: 'Body must be a JSON object' }])

  const issues: FieldIssue[] = []
  for (const key of Object.keys(input)) {
    if (!table.fields.has(key)) issues.push({ field: key, message: 'Unknown field' })
  }

  const values: Record<string, StoredValue> = {}

  for (const field of table.fields.values()) {
    const provided = Object.prototype.hasOwnProperty.call(input, field.name)

    if (provided) {
      try {
        values[field.name] = toStored(field, input[field.name])
      } catch (error) {
        issues.push({ field: field.name, message: messageOf(error) })
      }
      continue
    }

    if (field.default !== undefined) {
      try {
        values[field.name] = toStored(field, field.default)
      } catch (error) {
        issues.push({ field: field.name, message: `Invalid default: ${messageOf(error)}` })
      }
      continue
    }

    if (field.required) {
      issues.push({ field: field.name, message: 'Is required' })
      continue
    }

    values[field.name] = null
  }

  if (issues.length) throw new InputError(issues)
  return values
}

/** Validates a PATCH body. Only provided fields are touched. */
export function updateValues(table: RegisteredTable, input: unknown): Record<string, StoredValue> {
  if (!isPlainObject(input)) throw new InputError([{ field: '', message: 'Body must be a JSON object' }])

  const issues: FieldIssue[] = []
  const values: Record<string, StoredValue> = {}

  for (const [key, value] of Object.entries(input)) {
    const field = table.fields.get(key)
    if (!field) {
      issues.push({ field: key, message: 'Unknown field' })
      continue
    }
    try {
      values[key] = toStored(field, value)
    } catch (error) {
      issues.push({ field: key, message: messageOf(error) })
    }
  }

  if (!issues.length && Object.keys(values).length === 0) {
    issues.push({ field: '', message: 'Provide at least one field to update' })
  }

  if (issues.length) throw new InputError(issues)
  return values
}

/** Converts a stored row into the JSON shape clients expect. */
export function rowToApi(table: RegisteredTable, row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [column, value] of Object.entries(row)) {
    const field = table.fields.get(column)

    if (!field) {
      result[column] = value
      continue
    }

    if (field.type === 'boolean') {
      result[column] = value === null ? null : value === 1 || value === true
      continue
    }

    if (field.type === 'json') {
      if (typeof value !== 'string') {
        result[column] = value
        continue
      }
      try {
        result[column] = JSON.parse(value) as unknown
      } catch {
        // Stored outside the API; return the raw text rather than throwing.
        result[column] = value
      }
      continue
    }

    result[column] = value
  }

  return result
}

export function toStored(field: FieldConfig, value: unknown): StoredValue {
  if (value === null) {
    if (field.required) throw new ResultError('Cannot be null')
    return null
  }

  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') throw new ResultError('Expected a string')
      return value

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new ResultError('Expected an integer')
      return value

    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResultError('Expected a number')
      return value

    case 'boolean':
      if (typeof value !== 'boolean') throw new ResultError('Expected a boolean')
      return value ? 1 : 0

    case 'json': {
      if (typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
        throw new ResultError('Expected a JSON value')
      }
      const encoded = JSON.stringify(value)
      if (encoded === undefined) throw new ResultError('Expected a JSON value')
      return encoded
    }

    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new ResultError('Expected an ISO-8601 date string')
      }
      return value
    }

    case 'file': {
      if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
        throw new ResultError('Expected a stored file key')
      }
      return value
    }
  }
}

class ResultError extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

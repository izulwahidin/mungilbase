import { compileRule } from '../sql/expr/index.js'
import {
  tableColumns,
  type FieldConfig,
  type MungilConfig,
  type RulesConfig,
  type TableConfig,
} from '../config/schema.js'

export const OPERATIONS = ['list', 'view', 'create', 'update', 'delete'] as const
export type Operation = (typeof OPERATIONS)[number]

export interface RegisteredTable {
  name: string
  config: TableConfig
  columns: ReadonlySet<string>
  fields: ReadonlyMap<string, FieldConfig>
  rules: Readonly<RulesConfig>
}

export interface Registry {
  tables: ReadonlyMap<string, RegisteredTable>
  get(name: string): RegisteredTable | undefined
}

export class SchemaError extends Error {
  override readonly name = 'SchemaError'
}

/**
 * Validates the schema at boot by compiling every rule with a dummy uid.
 *
 * A rule that does not compile is a startup failure. That is the whole point:
 * a typo in an access rule must never become a 500 (or worse, an open table)
 * at request time.
 */
export function createRegistry(config: MungilConfig): Registry {
  const tables = new Map<string, RegisteredTable>()

  for (const table of config.tables) {
    const columns = tableColumns(table)

    for (const operation of OPERATIONS) {
      const rule = table.rules[operation]
      if (rule === null) continue
      try {
        compileRule(rule, { table: table.name, columns, auth: { uid: 'validation' } })
      } catch (error) {
        throw new SchemaError(
          `Invalid ${operation} rule on table "${table.name}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    tables.set(table.name, {
      name: table.name,
      config: table,
      columns,
      fields: new Map(table.fields.map((field) => [field.name, field])),
      rules: table.rules,
    })
  }

  return {
    tables,
    get(name) {
      return tables.get(name)
    },
  }
}

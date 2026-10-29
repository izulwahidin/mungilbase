/**
 * Seeds a table with synthetic rows for benchmarks and load tests.
 *
 *   npx tsx scripts/seed.ts --config ./bench.config.json --table notes --rows 100000
 *
 * Rows are inserted directly, bypassing rules (this is an operator tool).
 * Tables with foreign keys are refused: seed the referenced table and write
 * realistic relationships yourself, or the benchmark measures nonsense.
 */

import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config/load.js'
import { openDatabase } from '../src/db/connect.js'
import { ensureSchema, quote } from '../src/db/ddl.js'
import { createRegistry } from '../src/tables/registry.js'
import type { FieldConfig } from '../src/config/schema.js'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const configPath = option('config', process.env.MUNGIL_CONFIG ?? './mungil.config.ts')
const tableName = option('table', 'notes')
const rowCount = Number(option('rows', '10000'))
const batchSize = 1_000

if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 1_000_000) {
  throw new Error('--rows must be an integer between 1 and 1,000,000')
}

const config = await loadConfig(configPath)
const table = config.tables.find((candidate) => candidate.name === tableName)
if (!table) throw new Error(`Table "${tableName}" is not in ${configPath}`)

const foreignKeys = table.fields.filter((field) => field.references)
if (foreignKeys.length) {
  throw new Error(
    `Table "${tableName}" has foreign keys (${foreignKeys.map((field) => field.name).join(', ')}). ` +
      'This seeder does not fabricate relationships.',
  )
}

function valueFor(field: FieldConfig, index: number): string | number {
  switch (field.type) {
    case 'text':
      return field.name === 'email' ? `seed${index}@example.com` : `Seed ${field.name} ${index}`
    case 'integer':
      return index
    case 'real':
      return index / 10
    case 'boolean':
      return index % 2 === 0 ? 1 : 0
    case 'json':
      return JSON.stringify({ index, tag: `seed-${field.name}` })
    case 'date':
      return new Date(Date.now() - index * 60_000).toISOString()
    case 'file':
      return `seed/${String(index).padStart(16, '0')}/${field.name}/placeholder.txt`
  }
}

const db = openDatabase(process.env.MUNGIL_DB_FILE ?? config.database.file)
try {
  ensureSchema(db, createRegistry(config))

  const columns = ['id', ...table.fields.map((field) => field.name)]
  const insert = db.prepare(
    `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')})`,
  )

  const existing = (
    db.prepare(`SELECT COUNT(*) AS "count" FROM ${quote(table.name)}`).get() as { count: number }
  ).count

  const insertBatch = db.transaction((start: number, count: number) => {
    for (let index = start; index < start + count; index += 1) {
      insert.run(randomUUID(), ...table.fields.map((field) => valueFor(field, index)))
    }
  })

  const startedAt = Date.now()
  for (let offset = 0; offset < rowCount; offset += batchSize) {
    insertBatch(existing + offset, Math.min(batchSize, rowCount - offset))
  }

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'seed_complete',
      table: tableName,
      inserted: rowCount,
      total: existing + rowCount,
      durationMs: Date.now() - startedAt,
    }),
  )
} finally {
  db.close()
}

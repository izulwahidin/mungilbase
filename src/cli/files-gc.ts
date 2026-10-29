import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { createStorage } from '../storage/storage.js'
import { runFileGc } from '../storage/gc.js'
import { createRegistry } from '../tables/registry.js'

// Usage:
//   npm run files:gc                 # dry run
//   npm run files:gc -- --apply      # delete orphans
//   npm run files:gc -- ./config.json --apply
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const configPath =
  args.find((arg) => !arg.startsWith('--')) ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'

const config = await loadConfig(configPath)
const db = openDatabase(process.env.MUNGIL_DB_FILE ?? config.database.file)

try {
  const result = await runFileGc(db, createRegistry(config), createStorage(config.storage), {
    apply,
  })
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'files_gc',
      apply,
      ...result,
    }),
  )
} finally {
  db.close()
}

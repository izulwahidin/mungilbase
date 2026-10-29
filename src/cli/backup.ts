import { resolve } from 'node:path'
import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { backupDatabase } from '../db/backup.js'

// Usage:
//   npm run backup                          -> ./backups/mungil-<timestamp>.db
//   npm run backup -- /backups              -> /backups/mungil-<timestamp>.db
//   npm run backup -- /backups/snap.db      -> exact file
//   npm run backup -- /backups config.json  -> config path (defaults to MUNGIL_CONFIG)
const destinationArg = process.argv[2] ?? './backups'
const configPath = process.argv[3] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'

const config = await loadConfig(configPath)
const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file

if (dbFile === ':memory:') {
  console.error('Cannot back up an in-memory database.')
  process.exit(1)
}

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const destination = destinationArg.endsWith('.db')
  ? resolve(destinationArg)
  : resolve(destinationArg, `mungil-${stamp}.db`)

const db = openDatabase(dbFile, {})
try {
  const result = await backupDatabase(db, destination)
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'backup_complete',
      ...result,
      source: resolve(dbFile),
    }),
  )
} finally {
  db.close()
}

import { authConfigSchema } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { AuthService } from '../auth/service.js'
import { AppError } from '../http/errors.js'

const email = process.argv[2]
const password = process.env.MUNGIL_USER_PASSWORD

if (!email || !password) {
  console.error('Usage: MUNGIL_USER_PASSWORD="..." npm run user:passwd -- user@example.com')
  process.exit(1)
}

const configPath = process.argv[3] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'
const config = await loadConfig(configPath)
const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file

const db = openDatabase(dbFile)
try {
  ensureAuthSchema(db)
  const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
  const user = await service.setPassword(email, password)
  console.log(`Updated password for ${user.id} <${user.email}>; all sessions revoked.`)
} catch (error) {
  if (error instanceof AppError) {
    console.error(`Could not reset password: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  db.close()
}

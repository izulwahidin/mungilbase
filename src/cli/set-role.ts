import { authConfigSchema } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { isAuthRole } from '../auth/roles.js'
import { AuthService } from '../auth/service.js'
import { AppError } from '../http/errors.js'

const email = process.argv[2]
const role = process.argv[3]

if (!email || !role) {
  console.error('Usage: npm run user:role -- user@example.com admin')
  process.exit(1)
}
if (!isAuthRole(role)) {
  console.error('Role must be one of: user, admin')
  process.exit(1)
}

const configPath = process.argv[4] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'
const config = await loadConfig(configPath)
const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file

const db = openDatabase(dbFile)
try {
  ensureAuthSchema(db)
  const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
  const user = await service.setRole(email, role)
  console.log(`Set role "${user.role}" for ${user.id} <${user.email}>`)
} catch (error) {
  if (error instanceof AppError) {
    console.error(`Could not change role: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  db.close()
}

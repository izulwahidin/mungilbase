import { authConfigSchema } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import { openDatabase } from '../db/connect.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { isAuthRole } from '../auth/roles.js'
import { AuthService } from '../auth/service.js'
import { AppError } from '../http/errors.js'

const email = process.argv[2]
const password = process.env.MUNGIL_USER_PASSWORD
const role = process.env.MUNGIL_USER_ROLE ?? 'user'

if (!email || !password) {
  console.error('Usage: MUNGIL_USER_PASSWORD="..." npm run user:create -- user@example.com')
  process.exit(1)
}
if (!isAuthRole(role)) {
  console.error(`MUNGIL_USER_ROLE must be one of: user, admin`)
  process.exit(1)
}

const configPath = process.argv[3] ?? process.env.MUNGIL_CONFIG ?? './mungil.config.ts'
const config = await loadConfig(configPath)
const dbFile = process.env.MUNGIL_DB_FILE ?? config.database.file

const db = openDatabase(dbFile)
try {
  ensureAuthSchema(db)
  const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
  const user = await service.createUser({ email, password }, role)
  console.log(`Created ${user.role} ${user.id} <${user.email}>`)
} catch (error) {
  if (error instanceof AppError) {
    console.error(`Could not create user: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  db.close()
}

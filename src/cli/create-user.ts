import { createUser } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage: MUNGIL_USER_PASSWORD="..." npm run user:create -- user@example.com [config]
const email = process.argv[2]
if (!email) {
  console.error('Usage: MUNGIL_USER_PASSWORD="..." npm run user:create -- user@example.com')
  process.exit(1)
}

createUser(email, {
  password: process.env.MUNGIL_USER_PASSWORD,
  role: process.env.MUNGIL_USER_ROLE,
  configPath: process.argv[3],
}).catch(reportScriptError)

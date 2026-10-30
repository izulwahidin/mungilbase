import { resetPassword } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage: MUNGIL_USER_PASSWORD="..." npm run user:passwd -- user@example.com [config]
const email = process.argv[2]
if (!email) {
  console.error('Usage: MUNGIL_USER_PASSWORD="..." npm run user:passwd -- user@example.com')
  process.exit(1)
}

resetPassword(email, {
  password: process.env.MUNGIL_USER_PASSWORD,
  configPath: process.argv[3],
}).catch(reportScriptError)

import { setRole } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage: npm run user:role -- user@example.com admin [config]
const email = process.argv[2]
const role = process.argv[3]
if (!email || !role) {
  console.error('Usage: npm run user:role -- user@example.com admin')
  process.exit(1)
}

setRole(email, role, { configPath: process.argv[4] }).catch(reportScriptError)

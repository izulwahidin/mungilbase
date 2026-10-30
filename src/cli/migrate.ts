import { migrate } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage: npm run migrate [config path]
migrate({ configPath: process.argv[2] }).catch(reportScriptError)

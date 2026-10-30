import { sdk } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage:
//   npm run sdk
//   npm run sdk -- ./mungil.config.ts ./sdk/mungil-client.ts
sdk({ configPath: process.argv[2], output: process.argv[3] }).catch(reportScriptError)

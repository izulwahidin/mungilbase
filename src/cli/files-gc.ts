import { filesGc } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage:
//   npm run files:gc                 # dry run
//   npm run files:gc -- --apply      # delete orphans
//   npm run files:gc -- ./config.json --apply
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const configPath = args.find((arg) => !arg.startsWith('--'))

filesGc({ apply, configPath }).catch(reportScriptError)

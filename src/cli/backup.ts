import { backup } from './commands.js'
import { reportScriptError } from './script-error.js'

// Usage:
//   npm run backup                          -> ./backups/mungil-<timestamp>.db
//   npm run backup -- /backups              -> /backups/mungil-<timestamp>.db
//   npm run backup -- /backups/snap.db      -> exact file
//   npm run backup -- /backups config.json  -> config path (defaults to MUNGIL_CONFIG)
backup({ destination: process.argv[2], configPath: process.argv[3] }).catch(reportScriptError)

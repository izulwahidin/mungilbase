import { startServer } from './server.js'
import { ConfigError } from './config/load.js'
import { MigrationError } from './db/migrator.js'
import { SchemaError } from './tables/registry.js'
import { VERSION } from './version.js'

// Argument wins over environment so `node dist/index.js ./config.json` works
// even when the process environment is managed by an orchestrator.
const CONFIG_PATH = process.argv[2] ?? process.env.MUNGIL_CONFIG

startServer({ configPath: CONFIG_PATH, version: VERSION }).catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof SchemaError || error instanceof MigrationError) {
    console.error(`Startup failed: ${error.message}`)
  } else {
    console.error(error)
  }
  process.exit(1)
})

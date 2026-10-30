import { ConfigError } from '../config/load.js'
import { MigrationError } from '../db/migrator.js'
import { SchemaError } from '../tables/registry.js'
import { AppError } from '../http/errors.js'

/**
 * Error handler shared by the legacy `npm run <script>` entrypoints. The
 * `mungilbase` CLI has its own, more verbose, handler in `run.ts`.
 */
export function reportScriptError(error: unknown): void {
  if (
    error instanceof ConfigError ||
    error instanceof SchemaError ||
    error instanceof MigrationError ||
    error instanceof AppError
  ) {
    console.error(`Failed: ${error.message}`)
  } else {
    console.error(error)
  }
  process.exitCode = 1
}

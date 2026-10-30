/**
 * Public library surface for `mungilbase`.
 *
 * The CLI and the server entrypoint are separate: importing this module never
 * opens a database or starts a listener.
 */
export {
  configSchema,
  fieldSchema,
  fieldTypeSchema,
  rulesSchema,
  tableSchema,
  authConfigSchema,
  emailConfigSchema,
  storageConfigSchema,
  tableColumns,
  tableHasColumn,
} from './config/schema.js'
export type {
  AuthConfig,
  EmailConfig,
  FieldConfig,
  FieldType,
  MungilConfig,
  MungilConfigInput,
  RuleConfig,
  RulesConfig,
  StorageConfig,
  TableConfig,
  TableOperation,
} from './config/schema.js'
export {
  CONFIG_CANDIDATES,
  ConfigError,
  findConfigPath,
  loadConfig,
} from './config/load.js'
export { startServer } from './server.js'
export type { RunningServer, StartServerOptions } from './server.js'
export { init } from './cli/init.js'
export type { InitOptions, InitResult } from './cli/init.js'
export { gen } from './cli/commands.js'
export type { ArtifactStatus } from './cli/commands.js'
export { loadEnv, resolveEnvFile } from './cli/env.js'
export type { EnvFileStatus } from './cli/env.js'
export { buildOpenApi } from './openapi/spec.js'
export { VERSION } from './version.js'

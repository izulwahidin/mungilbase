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
export { createMcpServer } from './mcp/server.js'
export type { CreateMcpServerOptions, McpIdentity, McpInfo } from './mcp/server.js'
export { openMcpContext, runMcpServer } from './mcp/start.js'
export type { McpCommandOptions, McpContext } from './mcp/start.js'
export { generateSdk } from './sdk/generate.js'
export { buildOpenApi } from './openapi/spec.js'
export { VERSION } from './version.js'

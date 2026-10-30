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
export { applyMcpDefaults, openMcpContext, runMcpServer } from './mcp/start.js'
export type { McpCommandOptions, McpContext } from './mcp/start.js'
export { checkMcp } from './mcp/check.js'
export type { CheckResult } from './mcp/check.js'
export {
  MCP_CLIENTS,
  buildClientConfig,
  cliInvocation,
  clientConfigPath,
  mcpArgs,
  mergeClientConfig,
} from './mcp/client-config.js'
export type { ClientConfigOptions, McpClient, Rendering } from './mcp/client-config.js'
export { init } from './cli/init.js'
export type { InitOptions, InitResult } from './cli/init.js'
export { gen } from './cli/commands.js'
export type { ArtifactStatus } from './cli/commands.js'
export { loadEnv, resolveEnvFile } from './cli/env.js'
export type { EnvFileStatus } from './cli/env.js'
export { generateSdk } from './sdk/generate.js'
export { buildOpenApi } from './openapi/spec.js'
export { VERSION } from './version.js'

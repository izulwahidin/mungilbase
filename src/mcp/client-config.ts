import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const MCP_CLIENTS = ['opencode', 'claude', 'cursor', 'vscode', 'raw'] as const
export type McpClient = (typeof MCP_CLIENTS)[number]

export interface ClientConfigOptions {
  client: McpClient
  /** Absolute path to the mungilbase CLI entry point. */
  cliPath: string
  /** Node executable. Defaults to `process.execPath`. */
  nodePath?: string
  /** Absolute path to the config file. */
  configPath: string
  /** Directory the server should run in. */
  cwd?: string
  user?: string
  tables?: readonly string[]
  allowWrite?: boolean
  admin?: boolean
  allowRawSql?: boolean
}

export interface Rendering {
  /** Where `--write` would put the file, if the client has a known location. */
  path: string | null
  /** The merged document, ready to serialize. */
  document: Record<string, unknown>
  /** Paths inside the document that hold this server's entry, used by merge. */
  entry: Record<string, unknown>
}

/**
 * Builds a stdio command that does not depend on `npx`. The npm wrapper is an
 * extra process in front of the server, and some clients do not forward stdio
 * through it reliably; the node binary plus the CLI path always works.
 */
export function cliInvocation(
  cliPath: string,
  nodePath: string = process.execPath,
): { command: string; prefix: string[] } {
  const entry = resolve(cliPath)
  if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
    // Running from source (`tsx src/cli/main.ts`): keep the TypeScript loader.
    return { command: nodePath, prefix: ['--import', 'tsx', entry] }
  }
  return { command: nodePath, prefix: [entry] }
}

export function mcpArgs(options: ClientConfigOptions): string[] {
  const args = ['mcp', '--config', resolve(options.configPath)]
  if (options.user) args.push('--user', options.user)
  if (options.tables?.length) args.push('--tables', options.tables.join(','))
  if (options.allowWrite) args.push('--allow-write')
  if (options.admin) args.push('--admin')
  if (options.allowRawSql) args.push('--allow-raw-sql')
  return args
}

export function clientConfigPath(client: McpClient, cwd = process.cwd()): string | null {
  switch (client) {
    case 'opencode':
      return join(cwd, 'opencode.json')
    case 'cursor':
      return join(cwd, '.cursor', 'mcp.json')
    case 'vscode':
      return join(cwd, '.vscode', 'mcp.json')
    case 'claude':
      return claudeConfigPath()
    case 'raw':
      return null
  }
}

function claudeConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

/** The complete document a client would need if nothing else is configured. */
export function buildClientConfig(options: ClientConfigOptions): Rendering {
  const { command, prefix } = cliInvocation(options.cliPath, options.nodePath)
  const args = [...prefix, ...mcpArgs(options)]
  const cwd = resolve(options.cwd ?? process.cwd())

  let entry: Record<string, unknown>
  let document: Record<string, unknown>

  switch (options.client) {
    case 'opencode':
      entry = { type: 'local', command: [command, ...args], cwd }
      document = { $schema: 'https://opencode.ai/config.json', mcp: { servers: { mungilbase: entry } } }
      break
    case 'claude':
    case 'cursor':
      entry = { command, args }
      document = { mcpServers: { mungilbase: entry } }
      break
    case 'vscode':
      entry = { type: 'stdio', command, args, cwd }
      document = { servers: { mungilbase: entry } }
      break
    case 'raw':
      entry = { command, args, cwd }
      document = { mungilbase: entry }
      break
  }

  return { path: clientConfigPath(options.client, cwd), document, entry }
}

/**
 * Merges this server into an existing client config, leaving every unrelated
 * key alone. Comments are not supported: a JSONC file is reported instead of
 * being rewritten lossily.
 */
export async function mergeClientConfig(
  client: McpClient,
  path: string,
  entry: Record<string, unknown>,
): Promise<{ document: Record<string, unknown>; created: boolean; raw: string }> {
  let existing: Record<string, unknown> = {}
  let created = true

  if (existsSync(path)) {
    created = false
    const text = await readFile(path, 'utf8')
    if (!text.trim()) {
      existing = {}
    } else {
      try {
        existing = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new Error(
          `${path} is not plain JSON (comments are not supported). Add this server by hand:\n` +
            `${JSON.stringify({ mcpServers: { mungilbase: entry } }, null, 2)}`,
        )
      }
    }
  }

  const document = mergeEntry(client, existing, entry)
  return { document, created, raw: `${JSON.stringify(document, null, 2)}\n` }
}

function mergeEntry(
  client: McpClient,
  document: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...document }
  const ensure = (key: string): Record<string, unknown> => {
    const value = merged[key]
    const object = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    merged[key] = object
    return object
  }

  switch (client) {
    case 'opencode': {
      const mcp = ensure('mcp')
      const servers = (mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {}) as Record<string, unknown>
      mcp.servers = { ...servers, mungilbase: entry }
      break
    }
    case 'claude':
    case 'cursor': {
      const servers = ensure('mcpServers')
      servers.mungilbase = entry
      break
    }
    case 'vscode': {
      const servers = ensure('servers')
      servers.mungilbase = entry
      break
    }
    case 'raw': {
      return { ...entry }
    }
  }

  return merged
}

/** Directory used as `cwd`: the config file's own directory. */
export function configDirectory(configPath: string): string {
  return dirname(resolve(configPath))
}

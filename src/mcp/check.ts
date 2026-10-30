import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { VERSION } from '../version.js'
import { openMcpContext, type McpCommandOptions } from './start.js'

export interface CheckResult {
  ok: true
  version: string
  config: string
  database: string
  identity: string | null
  writeEnabled: boolean
  adminEnabled: boolean
  rawSqlEnabled: boolean
  tables: string[]
  tools: string[]
}

/**
 * Exercises the MCP server end to end without a pipe: opens the same context
 * the stdio server uses, connects a real client over an in-memory transport,
 * lists tools and calls `whoami`. This catches config, identity, rule and
 * registration problems in one command, before a client ever launches it.
 */
export async function checkMcp(
  options: McpCommandOptions = {},
  write: (line: string) => void = console.log,
): Promise<CheckResult> {
  const context = await openMcpContext(options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'mungilbase-check', version: options.version ?? VERSION },
    { capabilities: {} },
  )

  try {
    await Promise.all([context.server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listTools()
    const whoami = await client.callTool({ name: 'whoami', arguments: {} })
    const structured = whoami.structuredContent as Record<string, unknown> | undefined
    const info = structured ?? {}
    const identity = info.identity as { email?: string } | null | undefined

    const result: CheckResult = {
      ok: true,
      version: options.version ?? VERSION,
      config: context.configPath,
      database: context.dbFile,
      identity: identity?.email ?? null,
      writeEnabled: info.writeEnabled === true,
      adminEnabled: info.adminEnabled === true,
      rawSqlEnabled: info.rawSqlEnabled === true,
      tables: (info.tables as string[] | undefined) ?? [],
      tools: listed.tools.map((tool) => tool.name),
    }

    write(`MCP check ok — ${result.version}`)
    write(`Config    ${result.config}`)
    write(`Database  ${result.database}`)
    write(`Identity  ${result.identity ?? 'anonymous'}`)
    write(
      `Access    write=${flag(result.writeEnabled)} admin=${flag(result.adminEnabled)} rawSql=${flag(result.rawSqlEnabled)}`,
    )
    write(`Tables    ${result.tables.join(', ') || '(none)'}`)
    write(`Tools     ${result.tools.length}: ${result.tools.join(', ')}`)
    if (!result.identity && result.writeEnabled) {
      write(
        'Warning   writes are enabled but the identity is anonymous: rules that compare\n' +
          '          auth.uid will deny them. Pass --user <email> or set mcp.user in the config.',
      )
    }

    return result
  } finally {
    await client.close().catch(() => undefined)
    await context.server.close().catch(() => undefined)
    try {
      context.db.close()
    } catch {
      // Already closed.
    }
  }
}

function flag(value: boolean): string {
  return value ? 'on' : 'off'
}

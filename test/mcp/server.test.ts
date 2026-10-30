import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configSchema, type MungilConfig } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import { createRegistry, type Registry } from '../../src/tables/registry.js'
import { createMcpServer, type CreateMcpServerOptions } from '../../src/mcp/server.js'

const denials = { list: null, view: null, create: null, update: null, delete: null }

const config: MungilConfig = configSchema.parse({
  tables: [
    {
      name: 'users',
      fields: [{ name: 'email', type: 'text', required: true, unique: true }],
      rules: { ...denials, create: 'true' },
    },
    {
      name: 'posts',
      fields: [
        { name: 'author_id', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: false },
      ],
      rules: {
        list: 'published == true | auth.uid == author_id',
        view: 'published == true | auth.uid == author_id',
        create: 'auth.uid != null & author_id == auth.uid',
        update: 'auth.uid == author_id',
        delete: 'auth.uid == author_id',
      },
    },
  ],
})

interface Harness {
  client: Client
  db: Db
  registry: Registry
  close(): Promise<void>
}

async function harness(patch: Partial<CreateMcpServerOptions> = {}): Promise<Harness> {
  const db = openDatabase(':memory:')
  const registry = createRegistry(config)
  ensureSchema(db, registry)
  ensureAuditSchema(db)

  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u1', 'a@example.com')
  db.prepare(`INSERT INTO "users" ("id", "email") VALUES (?, ?)`).run('u2', 'b@example.com')
  insertPost(db, 'p1', 'u1', 'Mine', 0)
  insertPost(db, 'p2', 'u2', 'Private', 0)
  insertPost(db, 'p3', 'u2', 'Public', 1)

  const server = createMcpServer({
    config,
    registry,
    db,
    auth: { uid: 'u1', role: 'user', verified: true, admin: false },
    identity: { id: 'u1', email: 'a@example.com', role: 'user', emailVerified: true },
    version: 'test',
    ...patch,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  return {
    client,
    db,
    registry,
    async close() {
      await client.close()
      await server.close()
      db.close()
    },
  }
}

function insertPost(db: Db, id: string, author: string, title: string, published: number): void {
  db.prepare(
    `INSERT INTO "posts" ("id", "author_id", "title", "published") VALUES (?, ?, ?, ?)`,
  ).run(id, author, title, published)
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('No text content')
  return JSON.parse(text) as Record<string, unknown>
}

let current: Harness | undefined

beforeEach(() => {
  current = undefined
})

afterEach(async () => {
  await current?.close()
})

describe('MCP server', () => {
  it('exposes read tools and hides write tools by default', async () => {
    current = await harness()
    const tools = await current.client.listTools()
    const names = tools.tools.map((tool) => tool.name)

    expect(names).toEqual(
      expect.arrayContaining(['whoami', 'list_tables', 'describe_table', 'list_rows', 'get_row', 'get_openapi']),
    )
    expect(names).not.toContain('create_row')
    expect(names).not.toContain('update_row')
    expect(names).not.toContain('delete_row')
  })

  it('reports the active identity and table schema', async () => {
    current = await harness()
    const who = parse(await current.client.callTool({ name: 'whoami', arguments: {} }))
    expect(who.writeEnabled).toBe(false)
    expect(who.identity).toMatchObject({ id: 'u1', email: 'a@example.com' })

    const tables = parse(await current.client.callTool({ name: 'list_tables', arguments: {} }))
    expect(tables.count).toBe(2)
    expect(JSON.stringify(tables)).toContain('author_id')

    const described = parse(
      await current.client.callTool({ name: 'describe_table', arguments: { table: 'posts' } }),
    )
    expect(described.rules).toMatchObject({ create: 'auth.uid != null & author_id == auth.uid' })
  })

  it('applies list and view rules for the active identity', async () => {
    current = await harness()
    const listed = parse(
      await current.client.callTool({ name: 'list_rows', arguments: { table: 'posts', sort: 'id' } }),
    )
    const items = listed.items as Array<{ id: string }>
    expect(items.map((item) => item.id)).toEqual(['p1', 'p3'])

    const hidden = await current.client.callTool({
      name: 'get_row',
      arguments: { table: 'posts', id: 'p2' },
    })
    expect(hidden.isError).toBe(true)

    const visible = parse(
      await current.client.callTool({ name: 'get_row', arguments: { table: 'posts', id: 'p3' } }),
    )
    expect(visible.row).toMatchObject({ id: 'p3', title: 'Public' })
  })

  it('registers write tools only with allowWrite and still enforces rules', async () => {
    current = await harness({ allowWrite: true })
    const tools = await current.client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['create_row', 'update_row', 'delete_row']),
    )

    const denied = await current.client.callTool({
      name: 'create_row',
      arguments: { table: 'posts', values: { author_id: 'u2', title: 'Not mine' } },
    })
    expect(denied.isError).toBe(true)

    const created = parse(
      await current.client.callTool({
        name: 'create_row',
        arguments: { table: 'posts', values: { author_id: 'u1', title: 'From MCP' } },
      }),
    )
    const id = (created.row as { id: string }).id
    expect(id).toBeTruthy()

    parse(
      await current.client.callTool({
        name: 'update_row',
        arguments: { table: 'posts', id, values: { title: 'Updated via MCP' } },
      }),
    )
    const readBack = parse(
      await current.client.callTool({ name: 'get_row', arguments: { table: 'posts', id } }),
    )
    expect(readBack.row).toMatchObject({ title: 'Updated via MCP' })

    parse(await current.client.callTool({ name: 'delete_row', arguments: { table: 'posts', id } }))
    const gone = await current.client.callTool({ name: 'get_row', arguments: { table: 'posts', id } })
    expect(gone.isError).toBe(true)

    const audit = current.db
      .prepare(`SELECT event, outcome, operation FROM "_mungil_audit" ORDER BY id`)
      .all() as Array<{ event: string; outcome: string; operation: string }>
    expect(audit.map((entry) => `${entry.event}:${entry.outcome}`)).toEqual([
      'mcp.create:denied',
      'mcp.create:success',
      'mcp.update:success',
      'mcp.delete:success',
    ])
  })

  it('restricts tables when configured', async () => {
    current = await harness({ tables: ['posts'] })
    const tables = parse(await current.client.callTool({ name: 'list_tables', arguments: {} }))
    expect(tables.count).toBe(1)
    expect(JSON.stringify(tables)).not.toContain('users')

    const denied = await current.client.callTool({
      name: 'describe_table',
      arguments: { table: 'users' },
    })
    expect(denied.isError).toBe(true)
  })

  it('serves schema and OpenAPI resources', async () => {
    current = await harness()
    const resources = await current.client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['mungilbase://schema', 'mungilbase://openapi.json']),
    )

    const schema = await current.client.readResource({ uri: 'mungilbase://schema' })
    const first = schema.contents[0]
    expect(first && 'text' in first).toBe(true)
    if (!first || !('text' in first)) throw new Error('Expected a text resource')
    expect(first.text).toContain('"name": "posts"')
  })
})

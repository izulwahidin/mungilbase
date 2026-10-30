import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClientConfig,
  mergeClientConfig,
  mcpArgs,
  type ClientConfigOptions,
} from '../../src/mcp/client-config.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-client-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const appDir = resolve(sep, 'srv', 'app')

const base: ClientConfigOptions = {
  client: 'opencode',
  cliPath: resolve(sep, 'opt', 'mungilbase', 'dist', 'cli', 'main.js'),
  nodePath: resolve(sep, 'usr', 'bin', 'node'),
  configPath: join(appDir, 'mungil.config.ts'),
  cwd: appDir,
  user: 'me@example.com',
  tables: ['todos'],
  allowWrite: true,
}

describe('MCP client configuration', () => {
  it('builds an opencode entry that does not go through npx', () => {
    const rendering = buildClientConfig(base)
    const entry = (rendering.document.mcp as { servers: Record<string, unknown> }).servers.mungilbase as {
      command: string[]
      cwd: string
    }

    expect(entry.command[0]).toBe(base.nodePath)
    expect(entry.command[1]).toBe(base.cliPath)
    expect(entry.command).not.toContain('npx')
    expect(entry.command).toEqual(expect.arrayContaining(['mcp', '--config', base.configPath]))
    expect(entry.command).toEqual(expect.arrayContaining(['--user', 'me@example.com']))
    expect(entry.command).toEqual(expect.arrayContaining(['--tables', 'todos', '--allow-write']))
    expect(entry.cwd).toBe(appDir)
    expect(rendering.path).toBe(join(appDir, 'opencode.json'))
  })

  it('builds claude, cursor, vscode and raw shapes', () => {
    const claude = buildClientConfig({ ...base, client: 'claude' }).document as {
      mcpServers: { mungilbase: { command: string; args: string[] } }
    }
    expect(claude.mcpServers.mungilbase.command).toBe(base.nodePath)
    expect(claude.mcpServers.mungilbase.args[0]).toBe(base.cliPath)

    const cursor = buildClientConfig({ ...base, client: 'cursor' }).document as {
      mcpServers: Record<string, unknown>
    }
    expect(cursor.mcpServers.mungilbase).toBeTruthy()

    const vscode = buildClientConfig({ ...base, client: 'vscode' }).document as {
      servers: { mungilbase: { type: string } }
    }
    expect(vscode.servers.mungilbase.type).toBe('stdio')

    const raw = buildClientConfig({ ...base, client: 'raw' })
    expect(raw.path).toBeNull()
    expect((raw.document as { mungilbase: unknown }).mungilbase).toBeTruthy()
  })

  it('keeps TypeScript entries working through the tsx loader', () => {
    const rendering = buildClientConfig({ ...base, cliPath: join(appDir, 'src', 'cli', 'main.ts') })
    const entry = (rendering.document.mcp as { servers: { mungilbase: { command: string[] } } }).servers
      .mungilbase
    expect(entry.command.slice(1, 3)).toEqual(['--import', 'tsx'])
  })

  it('includes only the flags that are set', () => {
    const args = mcpArgs({ ...base, allowWrite: false, user: undefined, tables: undefined })
    expect(args).toEqual(['mcp', '--config', base.configPath])
  })

  it('merges into an existing client config without touching other keys', async () => {
    const directory = await workspace()
    const path = join(directory, 'opencode.json')
    await writeFile(
      path,
      JSON.stringify({ theme: 'dark', mcp: { servers: { other: { type: 'local', command: ['x'] } } } }),
      'utf8',
    )

    const rendering = buildClientConfig({ ...base, client: 'opencode' })
    const merged = await mergeClientConfig('opencode', path, rendering.entry)
    const document = merged.document as {
      theme: string
      mcp: { servers: Record<string, unknown> }
    }

    expect(merged.created).toBe(false)
    expect(document.theme).toBe('dark')
    expect(Object.keys(document.mcp.servers).sort()).toEqual(['mungilbase', 'other'])
    expect(JSON.parse(merged.raw)).toEqual(document)
  })

  it('creates a cursor config from nothing', async () => {
    const directory = await workspace()
    const path = join(directory, '.cursor', 'mcp.json')
    await mkdir(join(directory, '.cursor'), { recursive: true })

    const rendering = buildClientConfig({ ...base, client: 'cursor' })
    const merged = await mergeClientConfig('cursor', path, rendering.entry)
    expect(merged.created).toBe(true)
    expect(Object.keys((merged.document as { mcpServers: Record<string, unknown> }).mcpServers)).toEqual([
      'mungilbase',
    ])
  })

  it('refuses to rewrite a JSONC file', async () => {
    const directory = await workspace()
    const path = join(directory, 'opencode.json')
    await writeFile(path, '{\n  // comment\n  "mcp": {}\n}\n', 'utf8')

    const rendering = buildClientConfig({ ...base, client: 'opencode' })
    await expect(mergeClientConfig('opencode', path, rendering.entry)).rejects.toThrow(/not plain JSON/)
    expect(await readFile(path, 'utf8')).toContain('// comment')
  })
})

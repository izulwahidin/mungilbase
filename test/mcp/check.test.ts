import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '../../src/cli/init.js'
import { checkMcp } from '../../src/mcp/check.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-mcp-check-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('mcp --check', () => {
  it('connects a real client, lists tools and reports the identity', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    const configPath = join(directory, 'mungil.config.ts')

    const lines: string[] = []
    const result = await checkMcp({ configPath }, (line) => lines.push(line))

    expect(result.ok).toBe(true)
    expect(result.identity).toBe('demo@example.com')
    expect(result.tables).toEqual(['todos'])
    expect(result.writeEnabled).toBe(true)
    expect(result.tools).toEqual(
      expect.arrayContaining([
        'whoami',
        'list_tables',
        'describe_table',
        'list_rows',
        'get_row',
        'get_openapi',
        'create_row',
        'update_row',
        'delete_row',
      ]),
    )
    expect(result.database).toBe(join(directory, 'data', 'mungil.db'))
    expect(lines.join('\n')).toContain('MCP check ok')
  })

  it('fails fast for an unknown --tables entry', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    await expect(
      checkMcp({ configPath: join(directory, 'mungil.config.ts'), tables: ['nope'] }, () => {}),
    ).rejects.toThrow(/Unknown table/)
  })
})

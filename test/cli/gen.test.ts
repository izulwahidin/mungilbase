import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gen } from '../../src/cli/commands.js'
import { init } from '../../src/cli/init.js'

const directories: string[] = []
const originalCwd = process.cwd()

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-gen-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  process.chdir(originalCwd)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('mungilbase gen', () => {
  it('writes openapi.json and the SDK, then reports them as current', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    process.chdir(directory)

    const first = await gen({ configPath: join(directory, 'mungil.config.ts') })
    expect(first.stale.map((artifact) => artifact.kind).sort()).toEqual(['openapi', 'sdk'])
    expect(first.stale.every((artifact) => artifact.stale)).toBe(true)

    const openapi = JSON.parse(await readFile(join(directory, 'openapi.json'), 'utf8')) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(openapi.paths)).toContain('/api/v1/todos')
    expect(await readFile(join(directory, 'sdk', 'mungil-client.ts'), 'utf8')).toContain('todos')

    const second = await gen({ configPath: join(directory, 'mungil.config.ts'), check: true })
    expect(second.stale).toEqual([])

    const openapiPath = join(directory, 'openapi.json')
    await import('node:fs/promises').then((fs) => fs.writeFile(openapiPath, '{}\n', 'utf8'))
    const third = await gen({ configPath: join(directory, 'mungil.config.ts'), check: true })
    expect(third.stale.map((artifact) => artifact.path)).toEqual([openapiPath])
  })
})

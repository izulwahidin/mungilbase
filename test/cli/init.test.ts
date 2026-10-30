import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '../../src/cli/init.js'
import { loadConfig } from '../../src/config/load.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-init-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('mungilbase init', () => {
  it('scaffolds a config that the loader accepts', async () => {
    const directory = await workspace()
    const result = await init({ directory })

    expect(result.created.map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      'mungil.config.ts',
      '.env.example',
      '.gitignore',
      'index.html',
    ])

    const config = await loadConfig(join(directory, 'mungil.config.ts'))
    expect(config.tables.map((table) => table.name)).toEqual(['notes'])
    expect(config.auth?.allowSignup).toBe(true)
    expect(config.static).toMatchObject({ spa: true, dir: join(directory, 'public') })
  })

  it('writes a valid JSON config with --json', async () => {
    const directory = await workspace()
    await init({ directory, json: true })

    const config = await loadConfig(join(directory, 'mungil.config.json'))
    expect(config.tables[0]?.rules.list).toBe('published == true | auth.uid == owner_id')
  })

  it('refuses to overwrite an existing config without force', async () => {
    const directory = await workspace()
    await init({ directory })
    await writeFile(join(directory, 'mungil.config.ts'), '// keep me\n', 'utf8')

    await expect(init({ directory })).rejects.toThrow(/already exists/)

    await init({ directory, force: true })
    const contents = await readFile(join(directory, 'mungil.config.ts'), 'utf8')
    expect(contents).toContain("name: 'notes'")
  })
})

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '../../src/cli/init.js'
import { loadConfig } from '../../src/config/load.js'
import { openDatabase } from '../../src/db/connect.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-demo-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('mungilbase init --demo', () => {
  it('scaffolds a runnable todo app with a seeded account', async () => {
    const directory = await workspace()
    const result = await init({ directory, demo: true })

    const config = await loadConfig(join(directory, 'mungil.config.ts'))
    expect(config.tables.map((table) => table.name)).toEqual(['todos'])
    expect(config.static).toMatchObject({ spa: true, dir: join(directory, 'public') })
    expect(config.mcp).toMatchObject({ tables: ['todos'], allowWrite: true })

    const html = await readFile(join(directory, 'public', 'index.html'), 'utf8')
    expect(html).toContain('/api/v1')
    expect(html).toContain('todos')

    expect(result.demo?.email).toBe('demo@example.com')
    expect(result.demo?.password.length).toBeGreaterThanOrEqual(20)
    expect(result.demo?.todos).toBe(3)
    expect((await stat(result.demo!.database)).isFile()).toBe(true)

    const db = openDatabase(result.demo!.database)
    try {
      const count = db.prepare('SELECT COUNT(*) AS count FROM todos').get() as { count: number }
      expect(count.count).toBe(3)
      const done = db.prepare('SELECT COUNT(*) AS count FROM todos WHERE done = 1').get() as {
        count: number
      }
      expect(done.count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('honours --demo-email and --json', async () => {
    const directory = await workspace()
    const result = await init({ directory, demo: true, json: true, demoEmail: 'me@example.com' })

    const config = await loadConfig(join(directory, 'mungil.config.json'))
    expect(config.tables[0]?.name).toBe('todos')
    expect(result.demo?.email).toBe('me@example.com')
  })
})

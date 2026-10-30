import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { init } from '../src/cli/init.js'
import { startServer } from '../src/server.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-start-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('startServer guard rails', () => {
  it('fails on a busy port before opening or migrating the database', async () => {
    const directory = await workspace()
    await init({ directory })
    const configPath = join(directory, 'mungil.config.ts')
    const held = await holdPort()

    try {
      await expect(
        startServer({
          configPath,
          host: '127.0.0.1',
          port: held.port,
          handleSignals: false,
        }),
      ).rejects.toThrow(/already in use/)

      // The whole point: nothing touched the database, so no migration ran and
      // no file was created.
      await expect(stat(join(directory, 'data', 'mungil.db'))).rejects.toThrow()
    } finally {
      await held.release()
    }
  })

  it('boots, serves the static page and closes cleanly', async () => {
    const directory = await workspace()
    await init({ directory, demo: true })
    const configPath = join(directory, 'mungil.config.ts')

    const server = await startServer({
      configPath,
      host: '127.0.0.1',
      port: 0,
      handleSignals: false,
    })

    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`)
      expect(health.status).toBe(200)
      expect((await health.json()) as { status: string }).toMatchObject({ status: 'ok' })

      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('todos')

      const missingApi = await fetch(`http://127.0.0.1:${server.port}/api/v1/nope`)
      expect(missingApi.status).toBe(404)
      expect(missingApi.headers.get('content-type')).toContain('application/json')
    } finally {
      await server.close()
    }

    // Config-relative paths: the database sits next to the config file.
    expect((await stat(join(directory, 'data', 'mungil.db'))).isFile()).toBe(true)
    expect(await readFile(join(directory, 'public', 'index.html'), 'utf8')).toContain('/api/v1')
  }, 30_000)
})

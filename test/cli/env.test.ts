import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv, resolveEnvFile } from '../../src/cli/env.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mungil-env-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  delete process.env.MUNGIL_ENV_TEST_VALUE
  delete process.env.MUNGIL_ENV_TEST_OVERRIDE
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('env file loading', () => {
  it('loads .env from the working directory', async () => {
    const directory = await workspace()
    await writeFile(join(directory, '.env'), 'MUNGIL_ENV_TEST_VALUE=from-file\n', 'utf8')

    const status = loadEnv([], directory)
    expect(status.loaded).toBe(true)
    expect(status.path).toBe(join(directory, '.env'))
    expect(process.env.MUNGIL_ENV_TEST_VALUE).toBe('from-file')
  })

  it('does not override a real environment variable', async () => {
    const directory = await workspace()
    await writeFile(join(directory, '.env'), 'MUNGIL_ENV_TEST_OVERRIDE=file\n', 'utf8')
    process.env.MUNGIL_ENV_TEST_OVERRIDE = 'shell'

    loadEnv([], directory)
    expect(process.env.MUNGIL_ENV_TEST_OVERRIDE).toBe('shell')
  })

  it('honours --env-file and reports a missing explicit file', async () => {
    const directory = await workspace()
    await writeFile(join(directory, 'custom.env'), 'MUNGIL_ENV_TEST_VALUE=custom\n', 'utf8')

    expect(resolveEnvFile(['--env-file', 'custom.env'], directory)).toMatchObject({
      explicit: true,
      loaded: false,
    })

    const loaded = loadEnv(['--env-file', 'custom.env'], directory)
    expect(loaded.loaded).toBe(true)
    expect(process.env.MUNGIL_ENV_TEST_VALUE).toBe('custom')

    const missing = loadEnv(['--env-file', 'nope.env'], directory)
    expect(missing.error).toBe('not found')
    expect(missing.loaded).toBe(false)
  })

  it('reports no file when .env is absent and nothing was requested', async () => {
    const directory = await workspace()
    const status = loadEnv([], directory)
    expect(status.path).toBeNull()
    expect(status.loaded).toBe(false)
  })
})

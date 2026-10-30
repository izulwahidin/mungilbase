import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema, type MungilConfigInput } from '../../src/config/schema.js'
import { ConfigWriteError, configFormat, renderConfigSource, writeConfigFile } from '../../src/config/write.js'
import { loadConfigFile } from '../../src/config/load.js'

const input: MungilConfigInput = {
  appUrl: 'http://localhost:8787',
  auth: { allowSignup: true },
  tables: [
    {
      name: 'notes',
      fields: [{ name: 'title', type: 'text', required: true }],
      rules: { list: 'true', view: 'null', create: "auth.uid != null", update: null, delete: 'auth.uid == owner_id' },
    },
  ],
}

describe('config writer', () => {
  it('detects the format from the extension', () => {
    expect(configFormat('/a/mungil.config.ts')).toBe('esm')
    expect(configFormat('/a/mungil.config.json')).toBe('json')
    expect(configFormat('/a/mungil.config.cjs')).toBe('cjs')
    expect(() => configFormat('/a/mungil.config.yaml')).toThrow(ConfigWriteError)
  })

  it('renders TypeScript that parses back to the same config', async () => {
    const source = renderConfigSource(input, 'esm')
    expect(source).toContain('export default {')
    expect(source).toContain("name: 'notes'")

    const directory = await mkdtemp(join(tmpdir(), 'mungil-write-'))
    const file = join(directory, 'mungil.config.ts')
    await writeFile(file, source, 'utf8')

    const loaded = await loadConfigFile(file)
    expect(loaded.config.tables[0]?.name).toBe('notes')
    expect(loaded.config.tables[0]?.rules.list).toBe('true')
    expect(loaded.config.tables[0]?.rules.create).toBe('auth.uid != null')
    expect(loaded.config.auth?.allowSignup).toBe(true)
  })

  it('renders JSON and CommonJS', () => {
    expect(JSON.parse(renderConfigSource(input, 'json'))).toMatchObject({ appUrl: 'http://localhost:8787' })
    expect(renderConfigSource(input, 'cjs')).toContain('module.exports = {')
  })

  it('refuses to write a config the schema rejects', () => {
    expect(() =>
      renderConfigSource({ tables: [{ name: 'Bad Name' }] } as unknown as MungilConfigInput, 'json'),
    ).toThrow()
  })

  it('is re-read after a rewrite, for TypeScript and JavaScript configs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mungil-reload-'))

    for (const extension of ['ts', 'mjs']) {
      const file = join(directory, `mungil.config.${extension}`)
      await writeFile(file, renderConfigSource({ tables: [] }, extension === 'ts' ? 'esm' : 'esm'), 'utf8')
      expect((await loadConfigFile(file)).config.tables).toHaveLength(0)

      await writeConfigFile(file, input)
      const reloaded = await loadConfigFile(file)
      expect(reloaded.config.tables.map((table) => table.name)).toEqual(['notes'])
    }
  })

  describe('writeConfigFile', () => {
    let directory: string
    let file: string

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'mungil-write-'))
      file = join(directory, 'mungil.config.json')
    })

    afterAll(() => {
      // The temporary directory is cleaned up by the OS.
    })

    it('writes atomically and keeps the previous version as .bak', async () => {
      await writeFile(file, '{"tables":[]}\n', 'utf8')
      const result = await writeConfigFile(file, input)

      expect(result.backup).toBe(`${file}.bak`)
      expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual({ tables: [] })

      const written = JSON.parse(await readFile(file, 'utf8')) as MungilConfigInput
      expect(configSchema.safeParse(written).success).toBe(true)
      expect(written.tables?.[0]?.name).toBe('notes')
    })

    it('creates the file without a backup when there is no previous version', async () => {
      const fresh = join(directory, 'fresh.config.json')
      const result = await writeConfigFile(fresh, { tables: [] })
      expect(result.backup).toBeNull()
      expect(JSON.parse(await readFile(fresh, 'utf8'))).toEqual({ tables: [] })
    })
  })
})

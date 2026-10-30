import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

let directory: string
let db: Db
let app: ReturnType<typeof createApp>

const rules = { list: 'true', view: 'true', create: null, update: null, delete: null }

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mungil-static-'))
  await mkdir(join(directory, 'public', 'assets'), { recursive: true })
  await mkdir(join(directory, 'public', 'docs'), { recursive: true })
  await writeFile(join(directory, 'public', 'index.html'), '<!doctype html><h1>home</h1>', 'utf8')
  await writeFile(join(directory, 'public', 'assets', 'app.css'), 'body{color:red}', 'utf8')
  await writeFile(join(directory, 'public', 'docs', 'index.html'), '<h1>docs</h1>', 'utf8')
  await writeFile(join(directory, 'secret.txt'), 'do not serve me', 'utf8')

  const config = configSchema.parse({
    // loadConfig resolves paths from the config file; here we pass it absolute.
    static: { dir: join(directory, 'public'), spa: true, cacheControl: 'no-cache' },
    tables: [{ name: 'notes', fields: [{ name: 'text', type: 'text' }], rules }],
  })

  db = openDatabase(':memory:')
  ensureSchema(db, createRegistry(config))
  app = createApp({ config, db, version: 'test' })
})

afterAll(async () => {
  db.close()
  await rm(directory, { recursive: true, force: true })
})

describe('static hosting', () => {
  it('serves index.html at the root', async () => {
    const response = await app.request('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('home')
  })

  it('serves nested files with the right content type', async () => {
    const css = await app.request('/assets/app.css')
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(await css.text()).toBe('body{color:red}')

    const nested = await app.request('/docs/')
    expect(nested.status).toBe(200)
    expect(await nested.text()).toContain('docs')
  })

  it('answers HEAD and conditional requests without a body', async () => {
    const head = await app.request('/assets/app.css', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('15')
    expect(await head.text()).toBe('')

    const etag = head.headers.get('etag')
    expect(etag).toBeTruthy()
    const cached = await app.request('/assets/app.css', { headers: { 'if-none-match': etag! } })
    expect(cached.status).toBe(304)
  })

  it('falls back to index.html for client-side routes only when HTML is accepted', async () => {
    const navigation = await app.request('/todos/123', { headers: { accept: 'text/html' } })
    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain('home')

    const fetchCall = await app.request('/todos/123', { headers: { accept: 'application/json' } })
    expect(fetchCall.status).toBe(404)
  })

  it('never serves the API or admin paths as files', async () => {
    const api = await app.request('/api/v1/does-not-exist')
    expect(api.status).toBe(404)
    expect(api.headers.get('content-type')).toContain('application/json')
    expect(await api.json()).toMatchObject({ error: { code: 'not_found' } })

    const admin = await app.request('/admin')
    expect(admin.status).toBe(404)
    expect(admin.headers.get('content-type')).toContain('application/json')
  })

  it('rejects traversal outside the static root', async () => {
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fsecret.txt']) {
      const response = await app.request(path)
      const body = await response.text()
      expect(response.status).toBe(404)
      expect(body).not.toContain('do not serve me')
    }
  })
})

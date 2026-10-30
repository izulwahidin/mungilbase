import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const password = 'correct horse battery'

let directory: string
let configPath: string
let db: Db
let app: ReturnType<typeof createApp>
let cookie = ''
let csrf = ''

interface FormValues {
  [key: string]: string | string[]
}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header.slice(name.length + 1).split(';')[0] ?? null
  }
  return null
}

function body(values: FormValues): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry)
    else params.append(key, value)
  }
  return params.toString()
}

function post(target: ReturnType<typeof createApp>, path: string, values: FormValues): Promise<Response> {
  return Promise.resolve(
    target.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: body(values),
    }),
  )
}

function table(values: {
  name?: string
  fields: { name: string; type: string; required?: boolean; default?: string }[]
  rules?: Partial<Record<'list' | 'view' | 'create' | 'update' | 'delete', string>>
  timestamps?: boolean
}): FormValues {
  const rules = {
    list: 'true',
    view: 'true',
    create: 'auth.uid != null',
    update: 'auth.uid != null',
    delete: 'auth.uid != null',
    ...values.rules,
  }

  const out: FormValues = {
    _csrf: csrf,
    name: values.name ?? '',
    timestamps: values.timestamps === false ? 'off' : 'on',
    indexes: '',
    'field_name[]': values.fields.map((field) => field.name),
    'field_type[]': values.fields.map((field) => field.type),
    'field_required[]': values.fields.map((field) => (field.required ? '1' : '')),
    'field_unique[]': values.fields.map(() => ''),
    'field_default[]': values.fields.map((field) => field.default ?? ''),
    'field_ref_table[]': values.fields.map(() => ''),
    'field_ref_column[]': values.fields.map(() => ''),
    'field_max_bytes[]': values.fields.map(() => ''),
    'field_allowed_types[]': values.fields.map(() => ''),
  }

  for (const [operation, rule] of Object.entries(rules)) out[`rule_${operation}`] = rule
  return out
}

async function readConfig(): Promise<ReturnType<typeof configSchema.parse>> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  return configSchema.parse(raw)
}

describe('schema editor', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mungil-admin-'))
    configPath = join(directory, 'mungil.config.json')
    await writeFile(
      configPath,
      JSON.stringify({ appUrl: 'http://localhost:8787', auth: { allowSignup: false }, tables: [] }, null, 2),
      'utf8',
    )

    db = openDatabase(':memory:')
    const config = await readConfig()
    ensureSchema(db, createRegistry(config))
    ensureAuthSchema(db)
    ensureAuditSchema(db)
    app = createApp({ config, version: 'test', db, registry: createRegistry(config), configPath })

    // First-run setup gives the test an administrator without the CLI.
    const page = await app.request('/admin/setup')
    const token = cookieValue(page, 'mungil_csrf')
    if (!token) throw new Error('No CSRF cookie')
    csrf = token

    const created = await app.request('/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `mungil_csrf=${csrf}` },
      body: new URLSearchParams({ _csrf: csrf, email: 'owner@example.com', password, confirm: password }).toString(),
    })
    const admin = cookieValue(created, 'mungil_admin')
    if (!admin) throw new Error('Setup did not sign in')
    cookie = `mungil_csrf=${csrf}; mungil_admin=${admin}`
  })

  afterAll(() => {
    db.close()
  })

  it('renders the schema overview and the create form', async () => {
    const overview = await app.request('/admin/schema', { headers: { cookie } })
    expect(overview.status).toBe(200)
    const overviewHtml = await overview.text()
    expect(overviewHtml).toContain('Schema')
    expect(overviewHtml).toContain('No tables defined')
    expect(overviewHtml).toContain('mungil.config.json')

    const formPage = await app.request('/admin/schema/new', { headers: { cookie } })
    expect(formPage.status).toBe(200)
    const formHtml = await formPage.text()
    expect(formHtml).toContain('New table')
    expect(formHtml).toContain('field-row-template')
    expect(formHtml).toContain('rule_list')
  })

  it('creates a table, applies the DDL and writes the config file', async () => {
    const response = await post(app, '/admin/schema', table({
      name: 'notes',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: 'false' },
      ],
    }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/admin/schema')

    const written = await readConfig()
    expect(written.tables).toHaveLength(1)
    expect(written.tables[0]?.name).toBe('notes')
    expect(written.tables[0]?.fields[1]?.default).toBe(false)

    const columns = (db.prepare(`PRAGMA table_info("notes")`).all() as { name: string }[]).map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining(['id', 'title', 'published', 'created_at', 'updated_at']))

    // The REST route answers without a restart.
    const api = await app.request('/api/v1/notes')
    expect(api.status).toBe(200)

    const backup = await readFile(`${configPath}.bak`, 'utf8')
    expect(JSON.parse(backup)).toMatchObject({ tables: [] })
  })

  it('rejects a duplicate table without changing anything', async () => {
    const before = await readFile(configPath, 'utf8')
    const response = await post(app, '/admin/schema', table({
      name: 'notes',
      fields: [{ name: 'title', type: 'text' }],
    }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('already exists')
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('rejects a rule that does not compile', async () => {
    const before = await readFile(configPath, 'utf8')
    const response = await post(app, '/admin/schema/notes', table({
      name: 'notes',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: 'false' },
      ],
      rules: { list: 'missing_column == 1' },
    }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid list rule')
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('adds a nullable field through an edit', async () => {
    const response = await post(app, '/admin/schema/notes', table({
      name: 'notes',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: 'false' },
        { name: 'body', type: 'text' },
      ],
    }))
    expect(response.status).toBe(303)

    const columns = (db.prepare(`PRAGMA table_info("notes")`).all() as { name: string }[]).map((row) => row.name)
    expect(columns).toContain('body')

    const written = await readConfig()
    expect(written.tables[0]?.fields.map((field) => field.name)).toEqual(['title', 'published', 'body'])
  })

  it('requires a CSRF token for schema writes', async () => {
    const response = await app.request('/admin/schema', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: 'sneaky' }).toString(),
    })
    expect(response.status).toBe(403)
  })

  it('removes a table from the config but keeps its data', async () => {
    const response = await post(app, '/admin/schema/notes/delete', { _csrf: csrf })
    expect(response.status).toBe(303)

    const written = await readConfig()
    expect(written.tables).toHaveLength(0)

    const api = await app.request('/api/v1/notes')
    expect(api.status).toBe(404)

    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'`)
      .get() as { name: string } | undefined
    expect(exists?.name).toBe('notes')
  })

  it('is read-only when the app was created without a config path', async () => {
    const config = await readConfig()
    const embedded = createApp({ config, version: 'test', db, registry: createRegistry(config) })

    const login = await embedded.request('/admin/login')
    const loginCsrf = cookieValue(login, 'mungil_csrf')
    if (!loginCsrf) throw new Error('No CSRF cookie')

    const signedIn = await embedded.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `mungil_csrf=${loginCsrf}` },
      body: new URLSearchParams({ _csrf: loginCsrf, email: 'owner@example.com', password }).toString(),
    })
    const admin = cookieValue(signedIn, 'mungil_admin')
    if (!admin) throw new Error('Login failed')
    cookie = `mungil_csrf=${loginCsrf}; mungil_admin=${admin}`
    csrf = loginCsrf

    const page = await embedded.request('/admin/schema', { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('read-only')

    const attempt = await post(embedded, '/admin/schema', table({
      name: 'blocked',
      fields: [{ name: 'title', type: 'text' }],
    }))
    expect(attempt.status).toBe(409)
  })
})

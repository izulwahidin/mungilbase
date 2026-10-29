import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const config = configSchema.parse({
  appUrl: 'http://localhost:8787',
  auth: { allowSignup: true, adminBypassRules: true },
  tables: [
    {
      name: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'published', type: 'boolean', default: false },
      ],
      rules: {
        list: 'true',
        view: 'true',
        create: "auth.uid != null",
        update: "auth.uid != null",
        delete: "auth.uid != null",
      },
    },
  ],
})

const password = 'correct horse battery'
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  db = openDatabase(':memory:')
  ensureSchema(db, createRegistry(config))
  ensureAuthSchema(db)
  ensureAuditSchema(db)
  app = createApp({ config, version: 'test', db, registry: createRegistry(config) })

  const register = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password }),
  })
  expect(register.status).toBe(201)
  db.prepare(`UPDATE "_mungil_auth_users" SET "role" = 'admin' WHERE "email" = 'admin@example.com'`).run()

  await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password }),
  })
})

afterAll(() => {
  db.close()
})

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header.slice(name.length + 1).split(';')[0] ?? null
  }
  return null
}

function form(path: string, fields: Record<string, string>, cookie?: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  )
}

async function login(email: string): Promise<{ csrf: string; admin: string | null; response: Response }> {
  const page = await app.request('/admin/login')
  const csrf = cookieValue(page, 'mungil_csrf')
  if (!csrf) throw new Error('No CSRF cookie on login page')

  const response = await form(
    '/admin/login',
    { _csrf: csrf, email, password },
    `mungil_csrf=${csrf}`,
  )
  return { csrf, admin: cookieValue(response, 'mungil_admin'), response }
}

describe('admin panel', () => {
  it('redirects anonymous visitors and renders a login form', async () => {
    const dashboard = await app.request('/admin')
    expect(dashboard.status).toBe(303)
    expect(dashboard.headers.get('location')).toBe('/admin/login')

    const loginPage = await app.request('/admin/login')
    expect(loginPage.status).toBe(200)
    expect(await loginPage.text()).toContain('Admin login')
    expect(cookieValue(loginPage, 'mungil_csrf')).toHaveLength(43)
  })

  it('logs in an admin and browses a table', async () => {
    const { csrf, admin, response } = await login('admin@example.com')
    expect(response.status).toBe(303)
    expect(admin).toHaveLength(43)

    const cookie = `mungil_csrf=${csrf}; mungil_admin=${admin}`
    const dashboard = await app.request('/admin', { headers: { cookie } })
    expect(dashboard.status).toBe(200)
    const html = await dashboard.text()
    expect(html).toContain('posts')
    expect(html).toContain('admin@example.com')

    const list = await app.request('/admin/tables/posts', { headers: { cookie } })
    expect(list.status).toBe(200)
    expect(await list.text()).toContain('New row')
  })

  it('creates, edits and deletes rows through forms', async () => {
    const { csrf, admin, response } = await login('admin@example.com')
    expect(response.status).toBe(303)
    const cookie = `mungil_csrf=${csrf}; mungil_admin=${admin}`

    const created = await form(
      '/admin/tables/posts',
      { _csrf: csrf, f_title: 'From the panel', f_published: 'false' },
      cookie,
    )
    expect(created.status).toBe(303)

    const row = db.prepare(`SELECT "id", "title" FROM "posts"`).get() as { id: string; title: string }
    expect(row.title).toBe('From the panel')

    const edit = await app.request(`/admin/tables/posts/${row.id}`, { headers: { cookie } })
    expect(edit.status).toBe(200)
    expect(await edit.text()).toContain('From the panel')

    const updated = await form(
      `/admin/tables/posts/${row.id}`,
      { _csrf: csrf, f_title: 'Edited', f_published: 'true' },
      cookie,
    )
    expect(updated.status).toBe(303)
    const afterUpdate = db
      .prepare(`SELECT "title", "published" FROM "posts" WHERE "id" = ?`)
      .get(row.id) as { title: string; published: number }
    expect(afterUpdate).toEqual({ title: 'Edited', published: 1 })

    const deleted = await form(
      `/admin/tables/posts/${row.id}/delete`,
      { _csrf: csrf },
      cookie,
    )
    expect(deleted.status).toBe(303)

    const count = db.prepare(`SELECT COUNT(*) AS "count" FROM "posts"`).get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('rejects missing CSRF tokens and non-admin logins', async () => {
    const { csrf, admin } = await login('admin@example.com')
    const cookie = `mungil_csrf=${csrf}; mungil_admin=${admin}`

    const noCsrf = await form('/admin/tables/posts', { f_title: 'CSRF' }, cookie)
    expect(noCsrf.status).toBe(403)

    const { response } = await login('user@example.com')
    expect(response.status).toBe(403)
    expect(cookieValue(response, 'mungil_admin')).toBeNull()
  })

  it('logs out and invalidates the panel cookie', async () => {
    const { csrf, admin } = await login('admin@example.com')
    const cookie = `mungil_csrf=${csrf}; mungil_admin=${admin}`

    const logout = await form('/admin/logout', { _csrf: csrf }, cookie)
    expect(logout.status).toBe(303)

    const dashboard = await app.request('/admin', { headers: { cookie } })
    expect(dashboard.status).toBe(303)
  })
})

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
  auth: { allowSignup: true },
  tables: [
    {
      name: 'notes',
      fields: [{ name: 'title', type: 'text', required: true }],
      rules: { list: null, view: null, create: null, update: null, delete: null },
    },
  ],
})

let db: Db
let app: ReturnType<typeof createApp>

beforeAll(() => {
  db = openDatabase(':memory:')
  ensureSchema(db, createRegistry(config))
  ensureAuthSchema(db)
  ensureAuditSchema(db)
  app = createApp({ config, version: 'test', db, registry: createRegistry(config) })
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

describe('first-run setup', () => {
  it('sends visitors to the setup screen while no admin exists', async () => {
    for (const path of ['/admin', '/admin/login']) {
      const response = await app.request(path)
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/admin/setup')
    }

    const page = await app.request('/admin/setup')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Create the administrator')
    expect(cookieValue(page, 'mungil_csrf')).toHaveLength(43)
  })

  it('requires a CSRF token and matching passwords', async () => {
    const page = await app.request('/admin/setup')
    const csrf = cookieValue(page, 'mungil_csrf')
    if (!csrf) throw new Error('No CSRF cookie')

    const noCsrf = await form('/admin/setup', { email: 'owner@example.com', password: 'correct horse battery', confirm: 'correct horse battery' })
    expect(noCsrf.status).toBe(403)

    const mismatch = await form(
      '/admin/setup',
      { _csrf: csrf, email: 'owner@example.com', password: 'correct horse battery', confirm: 'something else' },
      `mungil_csrf=${csrf}`,
    )
    expect(mismatch.status).toBe(400)
    expect(await mismatch.text()).toContain('do not match')

    const short = await form(
      '/admin/setup',
      { _csrf: csrf, email: 'owner@example.com', password: 'short', confirm: 'short' },
      `mungil_csrf=${csrf}`,
    )
    expect(short.status).toBe(400)

    const admins = db
      .prepare(`SELECT COUNT(*) AS "n" FROM "_mungil_auth_users" WHERE "role" = 'admin'`)
      .get() as { n: number }
    expect(admins.n).toBe(0)
  })

  it('creates the first administrator, signs in, and then closes the screen', async () => {
    const page = await app.request('/admin/setup')
    const csrf = cookieValue(page, 'mungil_csrf')
    if (!csrf) throw new Error('No CSRF cookie')

    const created = await form(
      '/admin/setup',
      { _csrf: csrf, email: 'owner@example.com', password: 'correct horse battery', confirm: 'correct horse battery' },
      `mungil_csrf=${csrf}`,
    )
    expect(created.status).toBe(303)
    expect(created.headers.get('location')).toBe('/admin')
    const admin = cookieValue(created, 'mungil_admin')
    expect(admin).toHaveLength(43)

    const row = db
      .prepare(`SELECT "role", "email_verified" FROM "_mungil_auth_users" WHERE "email" = 'owner@example.com'`)
      .get() as { role: string; email_verified: number }
    expect(row).toEqual({ role: 'admin', email_verified: 1 })

    const audit = db
      .prepare(`SELECT "event" FROM "_mungil_audit" WHERE "event" = 'auth.admin_setup'`)
      .get() as { event: string } | undefined
    expect(audit?.event).toBe('auth.admin_setup')

    const dashboard = await app.request('/admin', {
      headers: { cookie: `mungil_csrf=${csrf}; mungil_admin=${admin}` },
    })
    expect(dashboard.status).toBe(200)
    expect(await dashboard.text()).toContain('owner@example.com')

    // The setup screen is gone: signed in it goes to the panel, otherwise to
    // the login form.
    const setup = await app.request('/admin/setup', {
      headers: { cookie: `mungil_csrf=${csrf}; mungil_admin=${admin}` },
    })
    expect(setup.status).toBe(303)
    expect(setup.headers.get('location')).toBe('/admin')

    const anonymousSetup = await app.request('/admin/setup')
    expect(anonymousSetup.headers.get('location')).toBe('/admin/login')

    const second = await form(
      '/admin/setup',
      { _csrf: csrf, email: 'attacker@example.com', password: 'correct horse battery', confirm: 'correct horse battery' },
      `mungil_csrf=${csrf}`,
    )
    expect(second.status).toBe(303)
    expect(second.headers.get('location')).toBe('/admin/login')

    const users = db.prepare(`SELECT COUNT(*) AS "n" FROM "_mungil_auth_users"`).get() as { n: number }
    expect(users.n).toBe(1)
  })
})

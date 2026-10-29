import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema, recordAudit } from '../../src/audit/log.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const rules = { list: 'true', view: 'true', create: null, update: null, delete: null }

const config = configSchema.parse({
  auth: {
    allowSignup: true,
    throttle: { account: { maxAttempts: 2, windowSeconds: 900 } },
  },
  tables: [
    {
      name: 'posts',
      fields: [{ name: 'title', type: 'text', required: true }],
      rules: { ...rules, create: 'auth.uid != null' },
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

function request(path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      body === undefined
        ? init
        : {
            ...init,
            headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
            body: JSON.stringify(body),
          },
    ),
  )
}

interface AuditRow {
  event: string
  outcome: string
  code: string | null
  table_name: string | null
  operation: string | null
  user_id: string | null
}

function auditRows(): AuditRow[] {
  return db
    .prepare(
      `SELECT "event", "outcome", "code", "table_name", "operation", "user_id"
       FROM "_mungil_audit" ORDER BY "id"`,
    )
    .all() as AuditRow[]
}

describe('audit log', () => {
  it('records rule denials with table, operation and outcome', async () => {
    const response = await request('/api/v1/posts', { title: 'Anon' }, { method: 'POST' })
    expect(response.status).toBe(403)

    const row = auditRows().find((entry) => entry.code === 'rule_violation')
    expect(row).toBeDefined()
    expect(row).toMatchObject({
      event: 'http.denied',
      outcome: 'denied',
      table_name: 'posts',
      operation: 'create',
      user_id: null,
    })
  })

  it('records successful logins and failed attempts', async () => {
    const registered = await request(
      '/api/v1/auth/register',
      { email: 'audit@example.com', password: 'correct horse battery' },
      { method: 'POST' },
    )
    expect(registered.status).toBe(201)

    const ok = await request(
      '/api/v1/auth/login',
      { email: 'audit@example.com', password: 'correct horse battery' },
      { method: 'POST' },
    )
    expect(ok.status).toBe(200)
    expect(auditRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'auth.login', outcome: 'success' })]),
    )

    const failed = await request(
      '/api/v1/auth/login',
      { email: 'audit@example.com', password: 'wrong password' },
      { method: 'POST' },
    )
    expect(failed.status).toBe(401)

    expect(auditRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'failure', code: 'unauthorized' }),
      ]),
    )
  })

  it('records throttling as its own code', async () => {
    await request(
      '/api/v1/auth/register',
      { email: 'limit@example.com', password: 'correct horse battery' },
      { method: 'POST' },
    )

    await request('/api/v1/auth/login', { email: 'limit@example.com', password: 'nope nope' }, { method: 'POST' })
    await request('/api/v1/auth/login', { email: 'limit@example.com', password: 'nope nope' }, { method: 'POST' })
    const limited = await request(
      '/api/v1/auth/login',
      { email: 'limit@example.com', password: 'nope nope' },
      { method: 'POST' },
    )
    expect(limited.status).toBe(429)

    expect(auditRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'rate_limited', outcome: 'failure' })]),
    )
  })

  it('never throws when the audit table is unavailable', () => {
    const isolated = openDatabase(':memory:')
    ensureAuditSchema(isolated)
    isolated.exec(`DROP TABLE "_mungil_audit"`)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => recordAudit(isolated, { event: 'test', outcome: 'success' })).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    isolated.close()
  })
})

describe('openapi endpoint', () => {
  it('serves the generated spec without being shadowed by /:table', async () => {
    const response = await request('/api/v1/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    const spec = (await response.json()) as Record<string, unknown>
    expect(spec.openapi).toBe('3.1.0')
    expect((spec.info as { version: string }).version).toBe('test')
  })
})

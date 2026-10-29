import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const posts = {
  name: 'posts',
  fields: [
    { name: 'author_id', type: 'text', required: true },
    { name: 'title', type: 'text', required: true },
    { name: 'published', type: 'boolean', default: false },
  ],
  rules: {
    list: 'published == true | auth.uid == author_id',
    view: 'published == true | auth.uid == author_id',
    create: 'auth.uid != null & author_id == auth.uid',
    update: 'auth.uid == author_id',
    delete: 'auth.uid == author_id',
  },
}

function configWith(adminBypassRules: boolean) {
  return configSchema.parse({
    auth: { allowSignup: true, adminBypassRules },
    tables: [posts],
  })
}

const password = 'correct horse battery'

let db: Db
let appFalse: ReturnType<typeof createApp>
let appTrue: ReturnType<typeof createApp>
let author: { id: string; accessToken: string }
let admin: { id: string; accessToken: string }
let draftId: string

beforeAll(async () => {
  db = openDatabase(':memory:')
  const falseConfig = configWith(false)
  const trueConfig = configWith(true)
  ensureSchema(db, createRegistry(falseConfig))
  ensureAuthSchema(db)
  ensureAuditSchema(db)

  appFalse = createApp({ config: falseConfig, version: 'test', db, registry: createRegistry(falseConfig) })
  appTrue = createApp({ config: trueConfig, version: 'test', db, registry: createRegistry(trueConfig) })

  async function register(email: string) {
    const response = await appFalse.request(
      '/api/v1/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { user: { id: string }; tokens: { accessToken: string } }
    return { id: body.user.id, accessToken: body.tokens.accessToken }
  }

  author = await register('author@example.com')
  admin = await register('admin@example.com')

  const created = await appFalse.request(
    '/api/v1/posts',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${author.accessToken}` },
      body: JSON.stringify({ author_id: author.id, title: 'Draft' }),
    },
  )
  expect(created.status).toBe(201)
  draftId = ((await created.json()) as { id: string }).id

  db.prepare(`UPDATE "_mungil_auth_users" SET "role" = 'admin' WHERE "email" = ?`).run(
    'admin@example.com',
  )
})

afterAll(() => {
  db.close()
})

function get(app: ReturnType<typeof createApp>, path: string, token: string): Promise<Response> {
  return Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${token}` } }))
}

describe('roles over HTTP', () => {
  it('reports the promoted role on /me without a re-login', async () => {
    const response = await get(appFalse, '/api/v1/auth/me', admin.accessToken)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ role: 'admin' })
  })

  it('does not bypass rules unless adminBypassRules is enabled', async () => {
    const list = await get(appFalse, '/api/v1/posts', admin.accessToken)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0)

    const view = await get(appFalse, `/api/v1/posts/${draftId}`, admin.accessToken)
    expect(view.status).toBe(404)
  })

  it('bypasses rules when adminBypassRules is enabled', async () => {
    const list = await get(appTrue, '/api/v1/posts', admin.accessToken)
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1)

    const view = await get(appTrue, `/api/v1/posts/${draftId}`, admin.accessToken)
    expect(view.status).toBe(200)

    const created = await appTrue.request('/api/v1/posts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${admin.accessToken}`,
      },
      body: JSON.stringify({ author_id: author.id, title: 'On behalf' }),
    })
    expect(created.status).toBe(201)
  })
})

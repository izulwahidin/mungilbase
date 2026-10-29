import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureSchema } from '../../src/db/ddl.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import type { AuthSessionResult } from '../../src/auth/service.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const config = configSchema.parse({
  auth: {
    allowSignup: true,
    throttle: { account: { maxAttempts: 3, windowSeconds: 900 } },
  },
  tables: [
    {
      name: 'posts',
      fields: [
        // Holds an auth user id. Auth users live in internal tables, so there
        // is deliberately no foreign key here.
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
    },
  ],
})

const registry = createRegistry(config)
const password = 'correct horse battery'
let db: Db
let app: ReturnType<typeof createApp>

beforeAll(() => {
  db = openDatabase(':memory:')
  ensureSchema(db, registry)
  ensureAuthSchema(db)
  app = createApp({ config, version: 'test', db, registry })
})

afterAll(() => {
  db.close()
})

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(path, init))
}

function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function register(email: string): Promise<AuthSessionResult> {
  const response = await request('/api/v1/auth/register', json({ email, password }))
  expect(response.status).toBe(201)
  return (await response.json()) as AuthSessionResult
}

async function login(email: string, candidate = password): Promise<Response> {
  return request('/api/v1/auth/login', json({ email, password: candidate }))
}

describe('auth routes', () => {
  it('registers, returns tokens, and serves /me', async () => {
    const session = await register('one@example.com')
    expect(session.user.email).toBe('one@example.com')
    expect(session.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const me = await request('/api/v1/auth/me', { headers: auth(session.tokens.accessToken) })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ id: session.user.id, email: 'one@example.com', role: 'user' })

    expect((await request('/api/v1/auth/me')).status).toBe(401)
    expect(
      (await request('/api/v1/auth/me', { headers: { authorization: 'Bearer garbage' } })).status,
    ).toBe(401)
  })

  it('logs in and rejects bad credentials uniformly', async () => {
    await register('two@example.com')

    const good = await login('two@example.com')
    expect(good.status).toBe(200)

    const wrong = await login('two@example.com', 'not the password')
    expect(wrong.status).toBe(401)
    const wrongBody = (await wrong.json()) as { error: { code: string; message: string } }

    const unknown = await login('ghost@example.com')
    expect(unknown.status).toBe(401)
    const unknownBody = (await unknown.json()) as { error: { code: string; message: string } }

    expect(wrongBody.error.message).toBe(unknownBody.error.message)
    expect(wrongBody.error.code).toBe('unauthorized')
  })

  it('uses the real token as auth.uid inside CRUD rules', async () => {
    const author = await register('author@example.com')
    const other = await register('other@example.com')

    const created = await request(
      '/api/v1/posts',
      json(
        { author_id: author.user.id, title: 'Hello' },
        { method: 'POST', headers: auth(author.tokens.accessToken) },
      ),
    )
    expect(created.status).toBe(201)
    const post = (await created.json()) as Record<string, unknown>

    const anonymousCreate = await request(
      '/api/v1/posts',
      json({ author_id: author.user.id, title: 'Anon' }, { method: 'POST' }),
    )
    expect(anonymousCreate.status).toBe(403)

    const forgedAuthor = await request(
      '/api/v1/posts',
      json(
        { author_id: author.user.id, title: 'Forged' },
        { method: 'POST', headers: auth(other.tokens.accessToken) },
      ),
    )
    expect(forgedAuthor.status).toBe(403)

    const hidden = await request(`/api/v1/posts/${String(post.id)}`, {
      headers: auth(other.tokens.accessToken),
    })
    expect(hidden.status).toBe(404)

    const published = await request(
      `/api/v1/posts/${String(post.id)}`,
      json({ published: true }, { method: 'PATCH', headers: auth(author.tokens.accessToken) }),
    )
    expect(published.status).toBe(200)

    const visible = await request(`/api/v1/posts/${String(post.id)}`, {
      headers: auth(other.tokens.accessToken),
    })
    expect(visible.status).toBe(200)

    const hijack = await request(
      `/api/v1/posts/${String(post.id)}`,
      json({ title: 'Hijack' }, { method: 'PATCH', headers: auth(other.tokens.accessToken) }),
    )
    expect(hijack.status).toBe(403)
  })

  it('rotates refresh tokens and revokes the family on replay', async () => {
    const session = await register('rotate@example.com')

    const refreshed = await request(
      '/api/v1/auth/refresh',
      json({ refreshToken: session.tokens.refreshToken }),
    )
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as AuthSessionResult
    expect(next.tokens.refreshToken).not.toBe(session.tokens.refreshToken)

    const me = await request('/api/v1/auth/me', { headers: auth(next.tokens.accessToken) })
    expect(me.status).toBe(200)

    const replay = await request(
      '/api/v1/auth/refresh',
      json({ refreshToken: session.tokens.refreshToken }),
    )
    expect(replay.status).toBe(401)

    // Family revoked: the "legitimate" rotated token is dead too.
    expect(
      (await request('/api/v1/auth/me', { headers: auth(next.tokens.accessToken) })).status,
    ).toBe(401)
    expect(
      (await request('/api/v1/auth/refresh', json({ refreshToken: next.tokens.refreshToken }))).status,
    ).toBe(401)
  })

  it('logs out and invalidates the access token', async () => {
    const session = await register('logout@example.com')

    const out = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: auth(session.tokens.accessToken),
    })
    expect(out.status).toBe(204)

    expect(
      (await request('/api/v1/auth/me', { headers: auth(session.tokens.accessToken) })).status,
    ).toBe(401)
  })

  it('rate limits repeated login failures', async () => {
    await register('throttle@example.com')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login('throttle@example.com', 'wrong password')).status).toBe(401)
    }

    const limited = await login('throttle@example.com', 'wrong password')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    const body = (await limited.json()) as { error: { code: string } }
    expect(body.error.code).toBe('rate_limited')
  })

  it('rejects malformed auth bodies', async () => {
    const response = await request('/api/v1/auth/login', json({ email: 'x' }))
    expect(response.status).toBe(400)

    const badRefresh = await request('/api/v1/auth/refresh', json({}))
    expect(badRefresh.status).toBe(400)
  })

  it('allows closing signup without touching the rest of the API', async () => {
    const closedConfig = configSchema.parse({
      ...config,
      auth: { ...config.auth, allowSignup: false },
    })
    const closed = createApp({ config: closedConfig, version: 'test', db, registry })

    const response = await closed.request(
      '/api/v1/auth/register',
      json({ email: 'late@example.com', password }),
    )
    expect(response.status).toBe(403)
  })
})

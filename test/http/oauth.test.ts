import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import type { OAuthProfile, OAuthProvider } from '../../src/auth/oauth.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

const config = configSchema.parse({
  appUrl: 'http://localhost:8787',
  auth: { oauth: { google: { clientId: 'google-id' } } },
  tables: [],
})

function fakeProvider(profile: OAuthProfile): OAuthProvider & { exchange: ReturnType<typeof vi.fn> } {
  return {
    name: 'google',
    authorizationUrl: (state) => `https://accounts.google.com/auth?state=${state}`,
    exchange: vi.fn(async () => profile),
  } as OAuthProvider & { exchange: ReturnType<typeof vi.fn> }
}

let db: Db

beforeAll(() => {
  db = openDatabase(':memory:')
  ensureAuthSchema(db)
  ensureAuditSchema(db)
})

afterAll(() => {
  db.close()
})

function stateCookie(response: Response): string {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('mungil_oauth_state='))
  if (!header) throw new Error('No state cookie')
  return header.split(';')[0]!
}

async function startAndCallback(app: ReturnType<typeof createApp>) {
  const start = await app.request('/api/v1/auth/oauth/google/start')
  expect(start.status).toBe(302)

  const location = new URL(start.headers.get('location')!)
  const state = location.searchParams.get('state')
  if (!state) throw new Error('No state in authorization URL')

  const callback = await app.request(
    `/api/v1/auth/oauth/google/callback?code=code-1&state=${encodeURIComponent(state)}`,
    { headers: { cookie: stateCookie(start) } },
  )
  return { start, callback }
}

describe('OAuth routes', () => {
  it('logs in, creates the account and returns tokens in the fragment', async () => {
    const provider = fakeProvider({
      provider: 'google',
      providerUserId: 'google-1',
      email: 'oauth@example.com',
      emailVerified: true,
    })
    const app = createApp({
      config,
      version: 'test',
      db,
      registry: createRegistry(config),
      oauthProviders: new Map([['google', provider]]),
    })

    const { callback } = await startAndCallback(app)
    expect(callback.status).toBe(302)

    const redirect = new URL(callback.headers.get('location')!)
    expect(redirect.origin + redirect.pathname).toBe('http://localhost:8787/auth/callback')

    const fragment = new URLSearchParams(redirect.hash.slice(1))
    const accessToken = fragment.get('access_token')
    expect(accessToken).toHaveLength(43)
    expect(fragment.get('refresh_token')).toHaveLength(43)

    const me = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { id: string }
    expect(meBody).toMatchObject({
      email: 'oauth@example.com',
      role: 'user',
      emailVerified: true,
    })

    // Logging in again reuses the same account.
    const second = await startAndCallback(app)
    const secondRedirect = new URL(second.callback.headers.get('location')!)
    const token2 = new URLSearchParams(secondRedirect.hash.slice(1)).get('access_token')
    const me2 = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${token2}` },
    })
    expect(((await me2.json()) as { id: string }).id).toBe(meBody.id)

    const users = db.prepare(`SELECT COUNT(*) AS "count" FROM "_mungil_auth_users"`).get() as {
      count: number
    }
    expect(users.count).toBe(1)
  })

  it('rejects unverified provider emails', async () => {
    const provider = fakeProvider({
      provider: 'google',
      providerUserId: 'google-2',
      email: 'unverified@example.com',
      emailVerified: false,
    })
    const app = createApp({
      config,
      version: 'test',
      db,
      registry: createRegistry(config),
      oauthProviders: new Map([['google', provider]]),
    })

    const { callback } = await startAndCallback(app)
    expect(callback.status).toBe(302)
    const redirect = new URL(callback.headers.get('location')!)
    expect(new URLSearchParams(redirect.hash.slice(1)).get('error')).toBe('email_not_verified')
  })

  it('rejects a mismatched state before exchanging the code', async () => {
    const provider = fakeProvider({
      provider: 'google',
      providerUserId: 'google-3',
      email: 'state@example.com',
      emailVerified: true,
    })
    const app = createApp({
      config,
      version: 'test',
      db,
      registry: createRegistry(config),
      oauthProviders: new Map([['google', provider]]),
    })

    const start = await app.request('/api/v1/auth/oauth/google/start')
    const callback = await app.request(
      '/api/v1/auth/oauth/google/callback?code=code-1&state=wrong',
      { headers: { cookie: stateCookie(start) } },
    )

    const redirect = new URL(callback.headers.get('location')!)
    expect(new URLSearchParams(redirect.hash.slice(1)).get('error')).toBe('invalid_state')
    expect(provider.exchange).not.toHaveBeenCalled()
  })

  it('returns 404 for providers that are not configured', async () => {
    const app = createApp({
      config,
      version: 'test',
      db,
      registry: createRegistry(config),
      oauthProviders: new Map(),
    })

    expect((await app.request('/api/v1/auth/oauth/facebook/start')).status).toBe(404)
  })
})

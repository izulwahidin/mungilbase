import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { ensureAuditSchema } from '../../src/audit/log.js'
import type { EmailMessage, Mailer } from '../../src/email/mailer.js'
import { createApp } from '../../src/http/app.js'
import { createRegistry } from '../../src/tables/registry.js'

class MemoryMailer implements Mailer {
  readonly messages: EmailMessage[] = []
  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message)
  }
}

const config = configSchema.parse({
  appUrl: 'http://localhost:8787',
  auth: {
    allowSignup: true,
    emailVerification: { enabled: true, required: true, maxRequestsPerHour: 1 },
  },
  email: { provider: 'log', from: 'noreply@example.com' },
  tables: [],
})

const password = 'correct horse battery'
let db: Db
let mailer: MemoryMailer
let app: ReturnType<typeof createApp>

beforeAll(() => {
  db = openDatabase(':memory:')
  ensureAuthSchema(db)
  ensureAuditSchema(db)
  mailer = new MemoryMailer()
  app = createApp({ config, version: 'test', db, registry: createRegistry(config), mailer })
})

afterAll(() => {
  db.close()
})

function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
  }
}

function tokenFrom(message: EmailMessage): string {
  const match = /token=([A-Za-z0-9_-]{43})/.exec(message.text)
  if (!match?.[1]) throw new Error('No token in email')
  return match[1]
}

async function register(email: string) {
  const response = await app.request(
    '/api/v1/auth/register',
    json({ email, password }),
  )
  expect(response.status).toBe(201)
  return (await response.json()) as {
    user: { id: string; emailVerified: boolean }
    tokens: { accessToken: string }
  }
}

describe('email verification routes', () => {
  it('sends a link, blocks login and verifies the address', async () => {
    const session = await register('verify@example.com')
    expect(session.user.emailVerified).toBe(false)
    expect(mailer.messages).toHaveLength(1)
    expect(mailer.messages[0]!.text).toContain('http://localhost:8787/verify-email?token=')

    const blocked = await app.request(
      '/api/v1/auth/login',
      json({ email: 'verify@example.com', password }),
    )
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'email_not_verified',
    )

    const token = tokenFrom(mailer.messages[0]!)
    const verified = await app.request('/api/v1/auth/verify-email', json({ token }))
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ status: 'ok' })

    // Existing access tokens see the new verification state.
    const me = await app.request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${session.tokens.accessToken}` },
    })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email: 'verify@example.com', emailVerified: true })

    const login = await app.request(
      '/api/v1/auth/login',
      json({ email: 'verify@example.com', password }),
    )
    expect(login.status).toBe(200)

    // Tokens are single use.
    expect(
      (await app.request('/api/v1/auth/verify-email', json({ token }))).status,
    ).toBe(400)
  })

  it('throttles resends and requires a session', async () => {
    const session = await register('resend@example.com')

    const anonymous = await app.request('/api/v1/auth/resend-verification', { method: 'POST' })
    expect(anonymous.status).toBe(401)

    const first = await app.request('/api/v1/auth/resend-verification', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.tokens.accessToken}` },
    })
    expect(first.status).toBe(202)

    const second = await app.request('/api/v1/auth/resend-verification', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.tokens.accessToken}` },
    })
    expect(second.status).toBe(429)
  })

  it('is absent when verification is disabled', async () => {
    const disabledConfig = configSchema.parse({
      ...config,
      auth: {
        ...config.auth,
        emailVerification: { enabled: false },
      },
    })
    const disabled = createApp({
      config: disabledConfig,
      version: 'test',
      db,
      registry: createRegistry(disabledConfig),
      mailer,
    })

    const response = await disabled.request(
      '/api/v1/auth/verify-email',
      json({ token: 'a'.repeat(43) }),
    )
    expect(response.status).toBe(404)
  })
})

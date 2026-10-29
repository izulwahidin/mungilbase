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
  auth: { allowSignup: true },
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
  app = createApp({
    config,
    version: 'test',
    db,
    registry: createRegistry(config),
    mailer,
  })
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

function request(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(path, json(body, init)))
}

async function register(email: string): Promise<{ id: string; accessToken: string }> {
  const response = await request('/api/v1/auth/register', { email, password })
  expect(response.status).toBe(201)
  const body = (await response.json()) as {
    user: { id: string }
    tokens: { accessToken: string }
  }
  return { id: body.user.id, accessToken: body.tokens.accessToken }
}

function tokenFrom(message: EmailMessage): string {
  const match = /token=([A-Za-z0-9_-]{43})/.exec(message.text)
  if (!match?.[1]) throw new Error('No token in email')
  return match[1]
}

describe('password reset routes', () => {
  it('completes a reset end to end', async () => {
    const user = await register('flow@example.com')

    const requested = await request('/api/v1/auth/request-password-reset', {
      email: 'flow@example.com',
    })
    expect(requested.status).toBe(202)
    expect(await requested.json()).toEqual({ status: 'accepted' })
    expect(mailer.messages).toHaveLength(1)
    expect(mailer.messages[0]!.text).toContain('http://localhost:8787/reset-password?token=')

    const token = tokenFrom(mailer.messages[0]!)

    const reset = await request('/api/v1/auth/reset-password', {
      token,
      password: 'another good password',
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ status: 'ok' })

    // Every session is revoked, including the one from registration.
    expect(
      (await app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${user.accessToken}` } }))
        .status,
    ).toBe(401)

    // Old password fails, new password works.
    expect(
      (await request('/api/v1/auth/login', { email: 'flow@example.com', password })).status,
    ).toBe(401)
    expect(
      (
        await request('/api/v1/auth/login', {
          email: 'flow@example.com',
          password: 'another good password',
        })
      ).status,
    ).toBe(200)
  })

  it('answers 202 for unknown addresses and sends nothing', async () => {
    const before = mailer.messages.length
    const response = await request('/api/v1/auth/request-password-reset', {
      email: 'ghost@example.com',
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(mailer.messages).toHaveLength(before)
  })

  it('rejects malformed addresses, bad tokens and weak passwords', async () => {
    expect(
      (await request('/api/v1/auth/request-password-reset', { email: 'not-an-email' })).status,
    ).toBe(400)

    expect(
      (await request('/api/v1/auth/reset-password', { token: 'x', password: 'another good password' }))
        .status,
    ).toBe(400)

    expect(
      (await request('/api/v1/auth/reset-password', { token: 'a'.repeat(43), password: 'short' }))
        .status,
    ).toBe(400)
  })

  it('is throttled per address', async () => {
    const limitedConfig = configSchema.parse({
      ...config,
      auth: { ...config.auth, passwordReset: { maxRequestsPerHour: 1 } },
    })
    const limitedMailer = new MemoryMailer()
    const limited = createApp({
      config: limitedConfig,
      version: 'test',
      db,
      registry: createRegistry(limitedConfig),
      mailer: limitedMailer,
    })

    const first = await limited.request(
      '/api/v1/auth/request-password-reset',
      json({ email: 'throttle-reset@example.com' }),
    )
    expect(first.status).toBe(202)

    const second = await limited.request(
      '/api/v1/auth/request-password-reset',
      json({ email: 'throttle-reset@example.com' }),
    )
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBeTruthy()
  })

  it('is absent when reset is disabled or email is not configured', async () => {
    const disabledConfig = configSchema.parse({
      ...config,
      auth: { ...config.auth, passwordReset: { enabled: false } },
    })
    const disabled = createApp({
      config: disabledConfig,
      version: 'test',
      db,
      registry: createRegistry(disabledConfig),
      mailer,
    })
    expect(
      (await disabled.request(
        '/api/v1/auth/request-password-reset',
        json({ email: 'flow@example.com' }),
      )).status,
    ).toBe(404)

    const noEmailConfig = configSchema.parse({
      appUrl: 'http://localhost:8787',
      auth: { allowSignup: true },
      tables: [],
    })
    const noEmail = createApp({
      config: noEmailConfig,
      version: 'test',
      db,
      registry: createRegistry(noEmailConfig),
    })
    expect(
      (await noEmail.request(
        '/api/v1/auth/request-password-reset',
        json({ email: 'flow@example.com' }),
      )).status,
    ).toBe(404)
  })
})

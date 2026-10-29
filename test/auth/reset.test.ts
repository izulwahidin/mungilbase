import { beforeEach, describe, expect, it } from 'vitest'
import { authConfigSchema, type AuthConfig } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { AppError } from '../../src/http/errors.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { AuthService } from '../../src/auth/service.js'
import type { EmailMessage, Mailer } from '../../src/email/mailer.js'

class MemoryMailer implements Mailer {
  readonly messages: EmailMessage[] = []

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message)
  }
}

const config: AuthConfig = authConfigSchema.parse({
  allowSignup: true,
  minPasswordLength: 10,
  passwordReset: { maxRequestsPerHour: 2 },
})

const email = 'reset@example.com'
const password = 'correct horse battery'
const resetOptions = {
  resetUrl: 'https://app.example.com/reset',
  ttlSeconds: 1800,
  maxRequestsPerHour: 2,
}

let db: Db
let service: AuthService
let mailer: MemoryMailer
let clock: Date

beforeEach(() => {
  db = openDatabase(':memory:')
  ensureAuthSchema(db)
  clock = new Date('2026-01-01T00:00:00.000Z')
  service = new AuthService(db, config, { now: () => clock })
  mailer = new MemoryMailer()
})

function advance(seconds: number): void {
  clock = new Date(clock.getTime() + seconds * 1000)
}

async function appErrorAsync(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Expected an AppError')
}

function tokenFrom(message: EmailMessage): string {
  const match = /token=([A-Za-z0-9_-]{43})/.exec(message.text)
  if (!match?.[1]) throw new Error('No token in email: ' + message.text)
  return match[1]
}

async function registered(): Promise<{ id: string; email: string }> {
  const session = await service.register({ email, password }, { ip: null })
  return session.user
}

describe('requestPasswordReset', () => {
  it('sends a link for a known address and stores only the hash', async () => {
    const user = await registered()
    const result = await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)

    expect(result).toEqual({ sent: true, userId: user.id })
    expect(mailer.messages).toHaveLength(1)

    const token = tokenFrom(mailer.messages[0]!)
    expect(mailer.messages[0]!.to).toBe(email)
    expect(mailer.messages[0]!.text).toContain('https://app.example.com/reset?token=')

    const rows = db
      .prepare(`SELECT "token_hash" FROM "_mungil_auth_password_resets"`)
      .all() as { token_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).not.toBe(token)
  })

  it('does not reveal whether an address exists', async () => {
    await registered()
    const result = await service.requestPasswordReset(
      'ghost@example.com',
      { ip: null },
      mailer,
      resetOptions,
    )

    expect(result).toEqual({ sent: false, userId: null })
    expect(mailer.messages).toHaveLength(0)

    const rows = db
      .prepare(`SELECT COUNT(*) AS "count" FROM "_mungil_auth_password_resets"`)
      .get() as { count: number }
    expect(rows.count).toBe(0)
  })

  it('invalidates the previous token when a new one is requested', async () => {
    await registered()
    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    const first = tokenFrom(mailer.messages[0]!)

    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    const second = tokenFrom(mailer.messages[1]!)

    expect((await appErrorAsync(() => service.resetPassword(first, 'another good password'))).statusCode).toBe(
      400,
    )
    const user = await service.resetPassword(second, 'another good password')
    expect(user.email).toBe(email)
  })

  it('throttles repeated requests per address', async () => {
    await registered()
    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)

    const limited = await appErrorAsync(() =>
      service.requestPasswordReset(email, { ip: null }, mailer, resetOptions),
    )
    expect(limited.statusCode).toBe(429)
    expect(limited.code).toBe('rate_limited')
  })
})

describe('resetPassword', () => {
  it('changes the password, revokes sessions and is single-use', async () => {
    const user = await registered()
    const session = await service.login({ email, password }, { ip: null })
    expect(service.resolveAccessToken(session.tokens.accessToken)).not.toBeNull()

    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    const token = tokenFrom(mailer.messages[0]!)

    const updated = await service.resetPassword(token, 'another good password')
    expect(updated).toEqual({ id: user.id, email, role: 'user' })

    // Old credentials and sessions are dead.
    expect(await appErrorAsync(() => service.login({ email, password }, { ip: null }))).toMatchObject({
      statusCode: 401,
    })
    expect(service.resolveAccessToken(session.tokens.accessToken)).toBeNull()

    // New credentials work.
    const relogin = await service.login({ email, password: 'another good password' }, { ip: null })
    expect(service.resolveAccessToken(relogin.tokens.accessToken)).not.toBeNull()

    // The token cannot be used twice.
    expect(
      (await appErrorAsync(() => service.resetPassword(token, 'another good password'))).statusCode,
    ).toBe(400)
  })

  it('rejects expired tokens', async () => {
    await registered()
    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    const token = tokenFrom(mailer.messages[0]!)

    advance(1801)
    expect(
      (await appErrorAsync(() => service.resetPassword(token, 'another good password'))).statusCode,
    ).toBe(400)
  })

  it('rejects malformed tokens and weak passwords without consuming the token', async () => {
    await registered()
    await service.requestPasswordReset(email, { ip: null }, mailer, resetOptions)
    const token = tokenFrom(mailer.messages[0]!)

    expect((await appErrorAsync(() => service.resetPassword('nope', 'another good password'))).statusCode).toBe(
      400,
    )
    expect((await appErrorAsync(() => service.resetPassword(token, 'short'))).statusCode).toBe(400)

    // Wrong password policy did not burn the token.
    expect((await service.resetPassword(token, 'another good password')).email).toBe(email)
  })
})

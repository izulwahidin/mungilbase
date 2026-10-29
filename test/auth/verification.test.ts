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
  emailVerification: { enabled: true, required: true, maxRequestsPerHour: 2 },
})

const email = 'verify@example.com'
const password = 'correct horse battery'
const options = { verifyUrl: 'https://app.example.com/verify-email', ttlSeconds: 3_600 }

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
  if (!match?.[1]) throw new Error('No token in email')
  return match[1]
}

async function registered() {
  return service.register({ email, password }, { ip: null })
}

describe('email verification', () => {
  it('blocks login until the address is verified, then allows it', async () => {
    const session = await registered()
    expect(session.user.emailVerified).toBe(false)

    const blocked = await appErrorAsync(() => service.login({ email, password }, { ip: null }))
    expect(blocked.statusCode).toBe(403)
    expect(blocked.code).toBe('email_not_verified')

    const sent = await service.requestEmailVerification(session.user.id, mailer, options)
    expect(sent).toEqual({ sent: true, userId: session.user.id })
    const token = tokenFrom(mailer.messages[0]!)

    const user = service.verifyEmail(token)
    expect(user.emailVerified).toBe(true)

    const signedIn = await service.login({ email, password }, { ip: null })
    expect(signedIn.user.emailVerified).toBe(true)
    expect(service.resolveAccessToken(signedIn.tokens.accessToken)?.emailVerified).toBe(true)
  })

  it('does not send for verified or unknown accounts', async () => {
    const session = await registered()
    expect(
      (await service.requestEmailVerification('missing-user', mailer, options)).sent,
    ).toBe(false)

    await service.requestEmailVerification(session.user.id, mailer, options)
    const token = tokenFrom(mailer.messages[0]!)
    service.verifyEmail(token)

    expect((await service.requestEmailVerification(session.user.id, mailer, options)).sent).toBe(false)
    expect(mailer.messages).toHaveLength(1)
  })

  it('rejects reused and expired tokens', async () => {
    const session = await registered()
    await service.requestEmailVerification(session.user.id, mailer, options)
    const first = tokenFrom(mailer.messages[0]!)
    service.verifyEmail(first)

    expect(() => service.verifyEmail(first)).toThrow(/Invalid or expired/)
    expect(() => service.verifyEmail('nope')).toThrow(/Invalid or expired/)

    const secondUser = await service.register(
      { email: 'later@example.com', password },
      { ip: null },
    )
    await service.requestEmailVerification(secondUser.user.id, mailer, options)
    const second = tokenFrom(mailer.messages[1]!)
    advance(3_601)
    expect(() => service.verifyEmail(second)).toThrow(/Invalid or expired/)
  })

  it('replaces the previous token and throttles resends', async () => {
    const session = await registered()
    await service.requestEmailVerification(session.user.id, mailer, options)
    const first = tokenFrom(mailer.messages[0]!)

    await service.requestEmailVerification(session.user.id, mailer, options)
    const second = tokenFrom(mailer.messages[1]!)
    expect(() => service.verifyEmail(first)).toThrow(/Invalid or expired/)
    service.verifyEmail(second)
  })
})

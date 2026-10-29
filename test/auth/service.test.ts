import { beforeEach, describe, expect, it } from 'vitest'
import { authConfigSchema, type AuthConfig } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { AppError } from '../../src/http/errors.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { AuthService } from '../../src/auth/service.js'

const config: AuthConfig = authConfigSchema.parse({
  allowSignup: true,
  minPasswordLength: 10,
  accessTokenTtlSeconds: 60,
  refreshTokenTtlSeconds: 3600,
  maxSessionTtlSeconds: 7200,
  throttle: { account: { maxAttempts: 3, windowSeconds: 900 } },
})

const email = 'a@example.com'
const password = 'correct horse battery'

let db: Db
let service: AuthService
let clock: Date

beforeEach(() => {
  db = openDatabase(':memory:')
  ensureAuthSchema(db)
  clock = new Date('2026-01-01T00:00:00.000Z')
  service = new AuthService(db, config, { now: () => clock })
})

function advance(seconds: number): void {
  clock = new Date(clock.getTime() + seconds * 1000)
}

function appError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Expected an AppError')
}

async function registered() {
  return service.register({ email, password }, { ip: null })
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

describe('registration', () => {
  it('stores a hash, never the password', async () => {
    const result = await registered()
    expect(result.user.email).toBe(email)
    expect(result.tokens.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const row = db.prepare(`SELECT "password_hash" FROM "_mungil_auth_users"`).get() as {
      password_hash: string
    }
    expect(row.password_hash).toMatch(/^\$argon2id\$/)
    expect(row.password_hash).not.toContain(password)
  })

  it('normalizes email casing and whitespace', async () => {
    const result = await service.register({ email: '  A@Example.COM ', password }, { ip: null })
    expect(result.user.email).toBe('a@example.com')
  })

  it('rejects duplicates, short passwords and invalid emails', async () => {
    await registered()
    expect((await appErrorAsync(() => service.register({ email, password }, { ip: null }))).code).toBe(
      'conflict',
    )
    const short = await appErrorAsync(() =>
      service.register({ email: 'b@example.com', password: 'short' }, { ip: null }),
    )
    expect(short.statusCode).toBe(400)

    const invalid = await appErrorAsync(() =>
      service.register({ email: 'not-an-email', password }, { ip: null }),
    )
    expect(invalid.statusCode).toBe(400)
  })

  it('refuses to register when signup is disabled', async () => {
    const closed = new AuthService(db, { ...config, allowSignup: false }, { now: () => clock })
    expect((await appErrorAsync(() => closed.register({ email, password }, { ip: null }))).code).toBe(
      'forbidden',
    )
  })
})

describe('login', () => {
  it('returns tokens for valid credentials', async () => {
    await registered()
    const result = await service.login({ email, password }, { ip: null })
    expect(result.user.email).toBe(email)
    expect(service.resolveAccessToken(result.tokens.accessToken)).not.toBeNull()
  })

  it('gives the same error for a wrong password and an unknown account', async () => {
    await registered()
    const wrong = await service
      .login({ email, password: 'wrong password!' }, { ip: null })
      .catch((error: AppError) => error)
    const unknown = await service
      .login({ email: 'ghost@example.com', password }, { ip: null })
      .catch((error: AppError) => error)

    expect(wrong).toBeInstanceOf(AppError)
    expect(unknown).toBeInstanceOf(AppError)
    expect((wrong as AppError).statusCode).toBe(401)
    expect((unknown as AppError).statusCode).toBe(401)
    expect((wrong as AppError).message).toBe((unknown as AppError).message)
  })

  it('throttles repeated failures per account', async () => {
    await registered()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failure = await appErrorAsync(() =>
        service.login({ email, password: 'wrong password!' }, { ip: null }),
      )
      expect(failure.statusCode).toBe(401)
    }

    const limited = await appErrorAsync(() =>
      service.login({ email, password: 'wrong password!' }, { ip: null }),
    )
    expect(limited.statusCode).toBe(429)
    expect(limited.code).toBe('rate_limited')
    expect((limited.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0)
  })

  it('resets the account counter after a successful login', async () => {
    await registered()
    await appErrorAsync(() => service.login({ email, password: 'nope nope nope' }, { ip: null }))
    await appErrorAsync(() => service.login({ email, password: 'nope nope nope' }, { ip: null }))

    await service.login({ email, password }, { ip: null })

    // Budget is fresh again: two more failures are still allowed.
    const first = await appErrorAsync(() => service.login({ email, password: 'nope nope nope' }, { ip: null }))
    expect(first.statusCode).toBe(401)
    const second = await appErrorAsync(() => service.login({ email, password: 'nope nope nope' }, { ip: null }))
    expect(second.statusCode).toBe(401)
  })
})

describe('access tokens', () => {
  it('expire after the configured ttl', async () => {
    const { tokens } = await registered()
    expect(service.resolveAccessToken(tokens.accessToken)).not.toBeNull()

    advance(61)
    expect(service.resolveAccessToken(tokens.accessToken)).toBeNull()

    // The refresh token outlives the access token.
    const refreshed = service.refresh(tokens.refreshToken)
    expect(service.resolveAccessToken(refreshed.tokens.accessToken)).not.toBeNull()
  })

  it('rejects malformed tokens without touching the database', async () => {
    expect(service.resolveAccessToken('')).toBeNull()
    expect(service.resolveAccessToken('not a token')).toBeNull()
    expect(service.resolveAccessToken('a'.repeat(43))).toBeNull()
  })
})

describe('refresh rotation', () => {
  it('rotates both tokens', async () => {
    const { tokens } = await registered()
    const refreshed = service.refresh(tokens.refreshToken)

    expect(refreshed.tokens.refreshToken).not.toBe(tokens.refreshToken)
    expect(refreshed.tokens.accessToken).not.toBe(tokens.accessToken)
    expect(refreshed.user.email).toBe(email)
  })

  it('revokes the whole family when a used token is replayed', async () => {
    const { tokens } = await registered()
    const refreshed = service.refresh(tokens.refreshToken)

    // The old refresh token was already used: replaying it is treated as theft.
    expect(appError(() => service.refresh(tokens.refreshToken)).code).toBe('unauthorized')

    // Both the attacker's and the legitimate client's tokens are now dead.
    expect(service.resolveAccessToken(tokens.accessToken)).toBeNull()
    expect(service.resolveAccessToken(refreshed.tokens.accessToken)).toBeNull()
    expect(appError(() => service.refresh(refreshed.tokens.refreshToken)).code).toBe('unauthorized')
  })

  it('caps sliding sessions at maxSessionTtlSeconds', async () => {
    const { tokens } = await registered()

    advance(3000)
    const refreshed = service.refresh(tokens.refreshToken)
    expect(service.resolveAccessToken(refreshed.tokens.accessToken)).not.toBeNull()

    advance(4500) // t0 + 7500s, beyond the 7200s session cap
    expect(appError(() => service.refresh(refreshed.tokens.refreshToken)).code).toBe('unauthorized')
  })

  it('rejects expired and malformed refresh tokens', async () => {
    const { tokens } = await registered()
    advance(3601)
    expect(appError(() => service.refresh(tokens.refreshToken)).code).toBe('unauthorized')
    expect(appError(() => service.refresh('nope')).code).toBe('unauthorized')
  })
})

describe('logout', () => {
  it('revokes the session and is idempotent', async () => {
    const { tokens } = await registered()
    expect(service.resolveAccessToken(tokens.accessToken)).not.toBeNull()

    service.logout(tokens.accessToken)
    expect(service.resolveAccessToken(tokens.accessToken)).toBeNull()

    service.logout(tokens.accessToken)
    service.logout('garbage')
    expect(appError(() => service.refresh(tokens.refreshToken)).code).toBe('unauthorized')
  })

  it('leaves other sessions alone', async () => {
    const first = await registered()
    const second = await service.login({ email, password }, { ip: null })

    service.logout(first.tokens.accessToken)
    expect(service.resolveAccessToken(second.tokens.accessToken)).not.toBeNull()
  })
})

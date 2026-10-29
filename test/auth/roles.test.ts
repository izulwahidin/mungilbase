import { beforeEach, describe, expect, it } from 'vitest'
import { authConfigSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { AppError } from '../../src/http/errors.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { AuthService } from '../../src/auth/service.js'

const config = authConfigSchema.parse({ allowSignup: true, minPasswordLength: 10 })
const email = 'role@example.com'
const password = 'correct horse battery'

let db: Db
let service: AuthService

beforeEach(() => {
  db = openDatabase(':memory:')
  ensureAuthSchema(db)
  service = new AuthService(db, config)
})

async function appErrorAsync(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Expected an AppError')
}

describe('roles', () => {
  it('creates users with the user role', async () => {
    const session = await service.register({ email, password }, { ip: null })
    expect(session.user.role).toBe('user')
  })

  it('applies a promotion immediately to existing tokens', async () => {
    const session = await service.register({ email, password }, { ip: null })
    expect(service.resolveAccessToken(session.tokens.accessToken)?.role).toBe('user')

    const updated = await service.setRole(email, 'admin')
    expect(updated.role).toBe('admin')

    // The token was issued before promotion; role is read from the DB.
    expect(service.resolveAccessToken(session.tokens.accessToken)?.role).toBe('admin')

    const relogin = await service.login({ email, password }, { ip: null })
    expect(relogin.user.role).toBe('admin')
    expect(service.refresh(session.tokens.refreshToken).user.role).toBe('admin')
  })

  it('rejects unknown roles and unknown accounts', async () => {
    await service.register({ email, password }, { ip: null })

    // Runtime guard, not just the TypeScript type.
    expect((await appErrorAsync(() => service.setRole(email, 'root' as never))).statusCode).toBe(400)
    expect((await appErrorAsync(() => service.setRole('ghost@example.com', 'admin'))).statusCode).toBe(
      404,
    )
  })

  it('migrates a 0.1.x users table by adding the role column', () => {
    const legacy = openDatabase(':memory:')
    legacy.exec(`
      CREATE TABLE "_mungil_auth_users" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "email" TEXT NOT NULL UNIQUE,
        "password_hash" TEXT NOT NULL,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL
      );
      INSERT INTO "_mungil_auth_users" ("id", "email", "password_hash", "created_at", "updated_at")
      VALUES ('u1', 'legacy@example.com', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `)

    ensureAuthSchema(legacy)
    ensureAuthSchema(legacy)

    const row = legacy
      .prepare(`SELECT "role" FROM "_mungil_auth_users" WHERE "id" = 'u1'`)
      .get() as { role: string }
    expect(row.role).toBe('user')

    const service = new AuthService(legacy, config)
    expect(service.userById('u1')).toEqual({ id: 'u1', email: 'legacy@example.com', role: 'user' })
    legacy.close()
  })
})

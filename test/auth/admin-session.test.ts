import { beforeEach, describe, expect, it } from 'vitest'
import { authConfigSchema } from '../../src/config/schema.js'
import { openDatabase, type Db } from '../../src/db/connect.js'
import { ensureAuthSchema } from '../../src/auth/schema.js'
import { AuthService } from '../../src/auth/service.js'

const config = authConfigSchema.parse({ allowSignup: true, minPasswordLength: 10 })
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

describe('admin sessions', () => {
  it('resolves only for admins and expires', async () => {
    const admin = await service.register(
      { email: 'admin@example.com', password: 'correct horse battery' },
      { ip: null },
    )
    await service.setRole('admin@example.com', 'admin')

    const token = await service.createAdminSession(admin.user.id, 3_600)
    expect(service.resolveAdminSession(token)).toMatchObject({ role: 'admin', email: 'admin@example.com' })

    advance(3_601)
    expect(service.resolveAdminSession(token)).toBeNull()
  })

  it('refuses non-admins and revoked sessions', async () => {
    const user = await service.register(
      { email: 'user@example.com', password: 'correct horse battery' },
      { ip: null },
    )

    const userToken = await service.createAdminSession(user.user.id, 3_600)
    expect(service.resolveAdminSession(userToken)).toBeNull()

    await service.setRole('user@example.com', 'admin')
    expect(service.resolveAdminSession(userToken)).not.toBeNull()

    service.revokeAdminSession(userToken)
    expect(service.resolveAdminSession(userToken)).toBeNull()
  })

  it('rejects malformed tokens without a database hit', () => {
    expect(service.resolveAdminSession('nope')).toBeNull()
  })
})

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/connect.js'
import { transaction } from '../db/tx.js'
import type { AuthConfig } from '../config/schema.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../http/errors.js'
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js'
import { createToken, hashToken, isWellFormedToken } from './tokens.js'
import { AUTH_TABLES, cleanupAuth } from './schema.js'
import { checkThrottle, clearThrottle } from './throttle.js'

export interface AuthUser {
  id: string
  email: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
}

export interface AuthSessionResult {
  user: AuthUser
  tokens: TokenPair
}

export interface SessionInfo {
  userId: string
  sessionId: string
}

export interface Credentials {
  email: string
  password: string
}

export interface RequestMeta {
  ip: string | null
}

export interface AuthServiceOptions {
  /** Injectable clock; tests use it to exercise expiry without sleeping. */
  now?: () => Date
}

interface UserRow {
  id: string
  email: string
  password_hash: string
}

interface RefreshRow {
  sessionId: string
  userId: string
  familyId: string
  email: string
  usedAt: string | null
  revokedAt: string | null
  tokenExpiresAt: string
  sessionExpiresAt: string
  sessionCreatedAt: string
}

type RefreshOutcome = { ok: true; result: AuthSessionResult } | { ok: false }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PASSWORD_LENGTH = 1024

export class AuthService {
  private readonly now: () => Date

  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
    options: AuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    cleanupAuth(this.db, this.now().toISOString())
  }

  /**
   * Registration. Closed by default (`allowSignup: false`); the conflict
   * message is explicit because the operator opted into open signup.
   */
  async register(input: Credentials, meta: RequestMeta): Promise<AuthSessionResult> {
    if (!this.config.allowSignup) throw forbidden('Signup is disabled')
    this.checkIpThrottle(meta.ip)
    const user = await this.createUser(input)
    return this.createSession(user)
  }

  /**
   * Creates an account without opening the signup route. Used by the
   * `user:create` CLI so a closed-signup deployment can still bootstrap.
   */
  async createUser(input: Credentials): Promise<AuthUser> {
    const email = normalizeEmail(input.email)
    this.validateNewPassword(input.password)

    const passwordHash = await hashPassword(input.password)
    const id = randomUUID()
    const timestamp = this.now().toISOString()

    try {
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.users}" ("id", "email", "password_hash", "created_at", "updated_at")
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, email, passwordHash, timestamp, timestamp)
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('An account with that email already exists')
      throw error
    }

    return { id, email }
  }

  /**
   * Operator-only password change. Revokes every session for the account, so
   * a reset cannot leave an attacker's session alive.
   */
  async setPassword(email: string, password: string): Promise<AuthUser> {
    const normalized = normalizeEmail(email)
    this.validateNewPassword(password)

    const row = this.db
      .prepare(`SELECT "id" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`)
      .get(normalized) as { id: string } | undefined
    if (!row) throw notFound('No account with that email')

    const passwordHash = await hashPassword(password)
    const now = this.now().toISOString()

    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.users}" SET "password_hash" = ?, "updated_at" = ? WHERE "id" = ?`,
        )
        .run(passwordHash, now, row.id)

      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.sessions}" SET "revoked_at" = ?
           WHERE "user_id" = ? AND "revoked_at" IS NULL`,
        )
        .run(now, row.id)

      this.db
        .prepare(
          `DELETE FROM "${AUTH_TABLES.tokens}"
           WHERE "session_id" IN (SELECT "id" FROM "${AUTH_TABLES.sessions}" WHERE "user_id" = ?)`,
        )
        .run(row.id)
    })

    return { id: row.id, email: normalized }
  }

  async login(input: Credentials, meta: RequestMeta): Promise<AuthSessionResult> {
    const email = normalizeEmail(input.email)
    const accountKey = `acct:${email}`

    // Count the attempt before doing any expensive work, including for
    // unknown accounts, so throttling cannot be bypassed by guessing emails.
    checkThrottle(this.db, accountKey, this.config.throttle.account, this.now().getTime())
    this.checkIpThrottle(meta.ip)

    const user = this.db
      .prepare(`SELECT "id", "email", "password_hash" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`)
      .get(email) as UserRow | undefined

    const valid = user
      ? await verifyPassword(user.password_hash, input.password)
      : await verifyDummyPassword(input.password)

    if (!user || !valid) throw unauthorized('Invalid email or password')

    clearThrottle(this.db, accountKey)
    return this.createSession({ id: user.id, email: user.email })
  }

  /**
   * Rotates a refresh token.
   *
   * Every refresh token is single-use. Presenting one that was already used
   * is treated as theft: the whole session family is revoked, including the
   * tokens the legitimate client holds. Better to log everyone out than to
   * let an attacker keep a parallel session.
   */
  refresh(refreshToken: string): AuthSessionResult {
    if (!isWellFormedToken(refreshToken)) throw unauthorized('Invalid refresh token')
    const hashed = hashToken(refreshToken)

    const outcome = transaction(this.db, (): RefreshOutcome => {
      const row = this.db
        .prepare(
          `SELECT t."session_id" AS "sessionId",
                  t."expires_at" AS "tokenExpiresAt",
                  t."used_at" AS "usedAt",
                  s."user_id" AS "userId",
                  s."family_id" AS "familyId",
                  s."revoked_at" AS "revokedAt",
                  s."expires_at" AS "sessionExpiresAt",
                  s."created_at" AS "sessionCreatedAt",
                  u."email" AS "email"
           FROM "${AUTH_TABLES.tokens}" t
           JOIN "${AUTH_TABLES.sessions}" s ON s."id" = t."session_id"
           JOIN "${AUTH_TABLES.users}" u ON u."id" = s."user_id"
           WHERE t."token_hash" = ? AND t."kind" = 'refresh'`,
        )
        .get(hashed) as RefreshRow | undefined

      if (!row) return { ok: false }

      if (row.usedAt !== null) {
        this.revokeFamily(row.familyId)
        return { ok: false }
      }

      if (row.revokedAt !== null) return { ok: false }

      const now = this.now()
      if (row.tokenExpiresAt <= now.toISOString() || row.sessionExpiresAt <= now.toISOString()) {
        return { ok: false }
      }

      const consumed = this.db
        .prepare(`UPDATE "${AUTH_TABLES.tokens}" SET "used_at" = ? WHERE "token_hash" = ? AND "used_at" IS NULL`)
        .run(now.toISOString(), hashed).changes

      if (consumed !== 1) {
        this.revokeFamily(row.familyId)
        return { ok: false }
      }

      // The session's absolute expiry is fixed at creation; refreshing slides
      // the refresh token but can never extend the session past its cap.
      this.db
        .prepare(`UPDATE "${AUTH_TABLES.sessions}" SET "last_seen_at" = ? WHERE "id" = ?`)
        .run(now.toISOString(), row.sessionId)

      return {
        ok: true,
        result: {
          user: { id: row.userId, email: row.email },
          tokens: this.issueTokens(row.sessionId, now, row.sessionExpiresAt),
        },
      }
    })

    if (!outcome.ok) throw unauthorized('Invalid refresh token')
    return outcome.result
  }

  /** Idempotent. An unknown or malformed token is a no-op. */
  logout(accessToken: string): void {
    if (!isWellFormedToken(accessToken)) return

    const row = this.db
      .prepare(
        `SELECT "session_id" AS "sessionId" FROM "${AUTH_TABLES.tokens}"
         WHERE "token_hash" = ? AND "kind" = 'access'`,
      )
      .get(hashToken(accessToken)) as { sessionId: string } | undefined

    if (!row) return

    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.sessions}" SET "revoked_at" = ? WHERE "id" = ? AND "revoked_at" IS NULL`,
        )
        .run(this.now().toISOString(), row.sessionId)
      this.db.prepare(`DELETE FROM "${AUTH_TABLES.tokens}" WHERE "session_id" = ?`).run(row.sessionId)
    })
  }

  resolveAccessToken(accessToken: string): SessionInfo | null {
    if (!isWellFormedToken(accessToken)) return null
    const now = this.now().toISOString()

    const row = this.db
      .prepare(
        `SELECT s."user_id" AS "userId", s."id" AS "sessionId"
         FROM "${AUTH_TABLES.tokens}" t
         JOIN "${AUTH_TABLES.sessions}" s ON s."id" = t."session_id"
         WHERE t."token_hash" = ? AND t."kind" = 'access'
           AND t."expires_at" > ? AND s."expires_at" > ? AND s."revoked_at" IS NULL`,
      )
      .get(hashToken(accessToken), now, now) as { userId: string; sessionId: string } | undefined

    return row ?? null
  }

  userById(id: string): AuthUser | null {
    const row = this.db
      .prepare(`SELECT "id", "email" FROM "${AUTH_TABLES.users}" WHERE "id" = ?`)
      .get(id) as AuthUser | undefined
    return row ?? null
  }

  private createSession(user: AuthUser): AuthSessionResult {
    const now = this.now()
    const sessionId = randomUUID()
    const familyId = randomUUID()
    const expires = new Date(now.getTime() + this.config.maxSessionTtlSeconds * 1000)

    const tokens = transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.sessions}"
             ("id", "family_id", "user_id", "created_at", "last_seen_at", "expires_at")
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, familyId, user.id, now.toISOString(), now.toISOString(), expires.toISOString())

      return this.issueTokens(sessionId, now, expires.toISOString())
    })

    return { user, tokens }
  }

  private issueTokens(sessionId: string, now: Date, sessionExpiresAt: string): TokenPair {
    const accessToken = createToken()
    const refreshToken = createToken()
    const accessExpires = new Date(now.getTime() + this.config.accessTokenTtlSeconds * 1000)
    const refreshExpires = new Date(
      Math.min(
        now.getTime() + this.config.refreshTokenTtlSeconds * 1000,
        Date.parse(sessionExpiresAt),
      ),
    )

    const insert = this.db.prepare(
      `INSERT INTO "${AUTH_TABLES.tokens}" ("token_hash", "session_id", "kind", "created_at", "expires_at")
       VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run(hashToken(accessToken), sessionId, 'access', now.toISOString(), accessExpires.toISOString())
    insert.run(hashToken(refreshToken), sessionId, 'refresh', now.toISOString(), refreshExpires.toISOString())

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessExpires.toISOString(),
      refreshTokenExpiresAt: refreshExpires.toISOString(),
    }
  }

  private revokeFamily(familyId: string): void {
    this.db
      .prepare(
        `UPDATE "${AUTH_TABLES.sessions}" SET "revoked_at" = ? WHERE "family_id" = ? AND "revoked_at" IS NULL`,
      )
      .run(this.now().toISOString(), familyId)
    this.db
      .prepare(
        `DELETE FROM "${AUTH_TABLES.tokens}"
         WHERE "session_id" IN (SELECT "id" FROM "${AUTH_TABLES.sessions}" WHERE "family_id" = ?)`,
      )
      .run(familyId)
  }

  private checkIpThrottle(ip: string | null): void {
    if (!ip) return
    checkThrottle(this.db, `ip:${ip}`, this.config.throttle.ip, this.now().getTime())
  }

  private validateNewPassword(password: string): void {
    if (password.length < this.config.minPasswordLength) {
      throw badRequest(`Password must be at least ${this.config.minPasswordLength} characters`)
    }
    if (password.length > MAX_PASSWORD_LENGTH) throw badRequest('Password is too long')
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw badRequest('Enter a valid email address')
  }
  return email
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

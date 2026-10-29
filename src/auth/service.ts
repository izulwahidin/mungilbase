import { randomUUID } from 'node:crypto'
import type { Db } from '../db/connect.js'
import { transaction } from '../db/tx.js'
import type { AuthConfig } from '../config/schema.js'
import {
  badRequest,
  conflict,
  emailNotVerified,
  forbidden,
  notFound,
  unauthorized,
} from '../http/errors.js'
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js'
import { createToken, hashToken, isWellFormedToken } from './tokens.js'
import { AUTH_TABLES, cleanupAuth } from './schema.js'
import { checkThrottle, clearThrottle } from './throttle.js'
import { isAuthRole, type AuthRole } from './roles.js'
import type { Mailer } from '../email/mailer.js'

export interface AuthUser {
  id: string
  email: string
  role: AuthRole
  emailVerified: boolean
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
  role: AuthRole
  emailVerified: boolean
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

export interface PasswordResetRequestOptions {
  /** Frontend URL that receives `?token=…`. */
  resetUrl: string
  ttlSeconds: number
  maxRequestsPerHour: number
}

export interface PasswordResetRequestResult {
  sent: boolean
  userId: string | null
}

export interface EmailVerificationOptions {
  verifyUrl: string
  ttlSeconds: number
}

export interface EmailVerificationResult {
  sent: boolean
  userId: string | null
}

interface UserRow {
  id: string
  email: string
  password_hash: string
  role: AuthRole
  email_verified: number
}

interface RefreshRow {
  sessionId: string
  userId: string
  familyId: string
  email: string
  role: AuthRole
  email_verified: number
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
    const user = await this.createUser(input, 'user', false)
    return this.createSession(user)
  }

  /**
   * Creates an account without opening the signup route. Used by the
   * `user:create` CLI so a closed-signup deployment can still bootstrap.
   */
  async createUser(
    input: Credentials,
    role: AuthRole = 'user',
    emailVerified = true,
  ): Promise<AuthUser> {
    if (!isAuthRole(role)) throw badRequest(`Unknown role "${String(role)}"`)

    const email = normalizeEmail(input.email)
    this.validateNewPassword(input.password)

    const passwordHash = await hashPassword(input.password)
    const id = randomUUID()
    const timestamp = this.now().toISOString()

    try {
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.users}"
             ("id", "email", "password_hash", "role", "email_verified", "created_at", "updated_at")
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, email, passwordHash, role, emailVerified ? 1 : 0, timestamp, timestamp)
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('An account with that email already exists')
      throw error
    }

    return { id, email, role, emailVerified }
  }

  /**
   * Operator-only password change. Revokes every session for the account, so
   * a reset cannot leave an attacker's session alive.
   */
  async setPassword(email: string, password: string): Promise<AuthUser> {
    const normalized = normalizeEmail(email)
    this.validateNewPassword(password)

    const row = this.db
      .prepare(`SELECT "id", "role", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`)
      .get(normalized) as { id: string; role: AuthRole; email_verified: number } | undefined
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

    return { id: row.id, email: normalized, role: row.role, emailVerified: row.email_verified === 1 }
  }

  /**
   * Starts a reset. Always resolves the same way for known and unknown
   * addresses; the caller must not branch on `sent`.
   *
   * Tokens are single-use, hashed at rest, and invalidated when replaced.
   */
  async requestPasswordReset(
    email: string,
    meta: RequestMeta,
    mailer: Mailer,
    options: PasswordResetRequestOptions,
  ): Promise<PasswordResetRequestResult> {
    const normalized = normalizeEmail(email)
    const now = this.now()

    checkThrottle(
      this.db,
      `reset:${normalized}`,
      { maxAttempts: options.maxRequestsPerHour, windowSeconds: 3_600 },
      now.getTime(),
    )
    if (meta.ip) {
      checkThrottle(
        this.db,
        `reset-ip:${meta.ip}`,
        { maxAttempts: options.maxRequestsPerHour * 5, windowSeconds: 3_600 },
        now.getTime(),
      )
    }

    const user = this.db
      .prepare(`SELECT "id", "email" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`)
      .get(normalized) as { id: string; email: string } | undefined

    if (!user) return { sent: false, userId: null }

    const token = createToken()
    const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000).toISOString()

    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE "${AUTH_TABLES.resets}" SET "used_at" = ? WHERE "user_id" = ? AND "used_at" IS NULL`)
        .run(now.toISOString(), user.id)
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.resets}" ("token_hash", "user_id", "created_at", "expires_at")
           VALUES (?, ?, ?, ?)`,
        )
        .run(hashToken(token), user.id, now.toISOString(), expiresAt)
    })

    try {
      await mailer.send({
        to: user.email,
        subject: 'Reset your MungilBase password',
        text:
          'Someone requested a password reset for this address.\n\n' +
          `${withToken(options.resetUrl, token)}\n\n` +
          `This link expires in ${Math.round(options.ttlSeconds / 60)} minutes. ` +
          'If you did not request it, ignore this email; your password is unchanged.',
      })
    } catch (error) {
      // The API answer stays uniform; the operator sees the failure in logs.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'password_reset_email_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }

    return { sent: true, userId: user.id }
  }

  async resetPassword(token: string, password: string): Promise<AuthUser> {
    if (!isWellFormedToken(token)) throw badRequest('Invalid or expired reset token')
    this.validateNewPassword(password)

    const hashed = hashToken(token)
    const now = this.now()
    const row = this.db
      .prepare(
        `SELECT r."user_id" AS "userId", r."expires_at" AS "expiresAt",
                r."used_at" AS "usedAt", u."email" AS "email", u."role" AS "role",
                u."email_verified" AS "email_verified"
         FROM "${AUTH_TABLES.resets}" r
         JOIN "${AUTH_TABLES.users}" u ON u."id" = r."user_id"
         WHERE r."token_hash" = ?`,
      )
      .get(hashed) as
      | {
          userId: string
          expiresAt: string
          usedAt: string | null
          email: string
          role: AuthRole
          email_verified: number
        }
      | undefined

    if (!row || row.usedAt !== null || row.expiresAt <= now.toISOString()) {
      throw badRequest('Invalid or expired reset token')
    }

    const passwordHash = await hashPassword(password)

    const result = transaction(this.db, (): AuthUser | null => {
      const consumed = this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.resets}" SET "used_at" = ?
           WHERE "token_hash" = ? AND "used_at" IS NULL AND "expires_at" > ?`,
        )
        .run(now.toISOString(), hashed, now.toISOString()).changes

      if (consumed !== 1) return null

      this.db
        .prepare(`UPDATE "${AUTH_TABLES.users}" SET "password_hash" = ?, "updated_at" = ? WHERE "id" = ?`)
        .run(passwordHash, now.toISOString(), row.userId)

      // A reset must not leave an attacker's session alive.
      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.sessions}" SET "revoked_at" = ?
           WHERE "user_id" = ? AND "revoked_at" IS NULL`,
        )
        .run(now.toISOString(), row.userId)

      this.db
        .prepare(
          `DELETE FROM "${AUTH_TABLES.tokens}"
           WHERE "session_id" IN (SELECT "id" FROM "${AUTH_TABLES.sessions}" WHERE "user_id" = ?)`,
        )
        .run(row.userId)

      this.db
        .prepare(`UPDATE "${AUTH_TABLES.resets}" SET "used_at" = ? WHERE "user_id" = ? AND "used_at" IS NULL`)
        .run(now.toISOString(), row.userId)

      return {
        id: row.userId,
        email: row.email,
        role: row.role,
        emailVerified: row.email_verified === 1,
      }
    })

    if (!result) throw badRequest('Invalid or expired reset token')
    return result
  }

  /**
   * Operator-only role change. Effective immediately: every request resolves
   * the role from the database, so no token carries a stale claim.
   */
  async setRole(email: string, role: AuthRole): Promise<AuthUser> {
    if (!isAuthRole(role)) throw badRequest(`Unknown role "${String(role)}"`)

    const normalized = normalizeEmail(email)
    const row = this.db
      .prepare(`SELECT "id", "role", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`)
      .get(normalized) as { id: string; role: AuthRole; email_verified: number } | undefined
    if (!row) throw notFound('No account with that email')

    if (row.role !== role) {
      this.db
        .prepare(`UPDATE "${AUTH_TABLES.users}" SET "role" = ?, "updated_at" = ? WHERE "id" = ?`)
        .run(role, this.now().toISOString(), row.id)
    }

    return { id: row.id, email: normalized, role, emailVerified: row.email_verified === 1 }
  }

  /**
   * Separate cookie session for the server-rendered admin panel. It is not an
   * access token: it exists only for `/admin`, has its own lifetime, and still
   * resolves the role from the users table on every request.
   */
  async createAdminSession(userId: string, ttlSeconds: number): Promise<string> {
    const token = createToken()
    const now = this.now()
    const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString()

    this.db
      .prepare(
        `INSERT INTO "${AUTH_TABLES.adminSessions}"
           ("token_hash", "user_id", "created_at", "expires_at")
         VALUES (?, ?, ?, ?)`,
      )
      .run(hashToken(token), userId, now.toISOString(), expires)

    return token
  }

  resolveAdminSession(token: string): AuthUser | null {
    if (!isWellFormedToken(token)) return null

    const row = this.db
      .prepare(
        `SELECT u."id" AS "id", u."email" AS "email", u."role" AS "role",
                u."email_verified" AS "email_verified"
         FROM "${AUTH_TABLES.adminSessions}" s
         JOIN "${AUTH_TABLES.users}" u ON u."id" = s."user_id"
         WHERE s."token_hash" = ? AND s."expires_at" > ? AND s."revoked_at" IS NULL`,
      )
      .get(hashToken(token), this.now().toISOString()) as
      | { id: string; email: string; role: AuthRole; email_verified: number }
      | undefined

    if (!row || row.role !== 'admin') return null
    return toAuthUser(row)
  }

  revokeAdminSession(token: string): void {
    if (!isWellFormedToken(token)) return

    this.db
      .prepare(
        `UPDATE "${AUTH_TABLES.adminSessions}" SET "revoked_at" = ?
         WHERE "token_hash" = ? AND "revoked_at" IS NULL`,
      )
      .run(this.now().toISOString(), hashToken(token))
  }

  /**
   * Creates and sends a verification link. Unknown or already-verified
   * accounts return `sent: false` without revealing which case it was.
   */
  async requestEmailVerification(
    userId: string,
    mailer: Mailer,
    options: EmailVerificationOptions,
  ): Promise<EmailVerificationResult> {
    const user = this.db
      .prepare(
        `SELECT "id", "email", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "id" = ?`,
      )
      .get(userId) as { id: string; email: string; email_verified: number } | undefined

    if (!user || user.email_verified === 1) return { sent: false, userId: user?.id ?? null }

    const now = this.now()
    const token = createToken()
    const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000).toISOString()

    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.verifications}" SET "used_at" = ?
           WHERE "user_id" = ? AND "used_at" IS NULL`,
        )
        .run(now.toISOString(), user.id)
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.verifications}" ("token_hash", "user_id", "created_at", "expires_at")
           VALUES (?, ?, ?, ?)`,
        )
        .run(hashToken(token), user.id, now.toISOString(), expiresAt)
    })

    try {
      await mailer.send({
        to: user.email,
        subject: 'Verify your MungilBase email',
        text:
          'Confirm this address to finish setting up your account.\n\n' +
          `${withToken(options.verifyUrl, token)}\n\n` +
          `This link expires in ${Math.round(options.ttlSeconds / 3600)} hours. ` +
          'If you did not create an account, ignore this email.',
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'email_verification_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }

    return { sent: true, userId: user.id }
  }

  async resendEmailVerification(
    userId: string,
    meta: RequestMeta,
    mailer: Mailer,
    options: EmailVerificationOptions & { maxRequestsPerHour: number },
  ): Promise<EmailVerificationResult> {
    const now = this.now()
    checkThrottle(
      this.db,
      `verify:${userId}`,
      { maxAttempts: options.maxRequestsPerHour, windowSeconds: 3_600 },
      now.getTime(),
    )
    if (meta.ip) {
      checkThrottle(
        this.db,
        `verify-ip:${meta.ip}`,
        { maxAttempts: options.maxRequestsPerHour * 5, windowSeconds: 3_600 },
        now.getTime(),
      )
    }

    return this.requestEmailVerification(userId, mailer, options)
  }

  verifyEmail(token: string): AuthUser {
    if (!isWellFormedToken(token)) throw badRequest('Invalid or expired verification token')

    const hashed = hashToken(token)
    const now = this.now()
    const row = this.db
      .prepare(
        `SELECT v."user_id" AS "userId", v."expires_at" AS "expiresAt",
                v."used_at" AS "usedAt", u."email" AS "email", u."role" AS "role",
                u."email_verified" AS "email_verified"
         FROM "${AUTH_TABLES.verifications}" v
         JOIN "${AUTH_TABLES.users}" u ON u."id" = v."user_id"
         WHERE v."token_hash" = ?`,
      )
      .get(hashed) as
      | {
          userId: string
          expiresAt: string
          usedAt: string | null
          email: string
          role: AuthRole
          email_verified: number
        }
      | undefined

    if (!row || row.usedAt !== null || row.expiresAt <= now.toISOString()) {
      throw badRequest('Invalid or expired verification token')
    }

    transaction(this.db, () => {
      const consumed = this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.verifications}" SET "used_at" = ?
           WHERE "token_hash" = ? AND "used_at" IS NULL AND "expires_at" > ?`,
        )
        .run(now.toISOString(), hashed, now.toISOString()).changes

      if (consumed !== 1) throw badRequest('Invalid or expired verification token')

      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.users}" SET "email_verified" = 1, "updated_at" = ? WHERE "id" = ?`,
        )
        .run(now.toISOString(), row.userId)

      this.db
        .prepare(
          `UPDATE "${AUTH_TABLES.verifications}" SET "used_at" = ?
           WHERE "user_id" = ? AND "used_at" IS NULL`,
        )
        .run(now.toISOString(), row.userId)
    })

    return { id: row.userId, email: row.email, role: row.role, emailVerified: true }
  }

  /**
   * Links an OAuth identity to an account by email.
   *
   * The provider must have verified the address; otherwise an attacker could
   * claim someone else's account. Existing password accounts keep their
   * password and become verified.
   */
  async findOrCreateOAuthUser(email: string): Promise<AuthUser> {
    const normalized = normalizeEmail(email)

    const existing = this.db
      .prepare(
        `SELECT "id", "email", "role", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`,
      )
      .get(normalized) as
      | { id: string; email: string; role: AuthRole; email_verified: number }
      | undefined

    if (existing) {
      if (existing.email_verified !== 1) {
        this.db
          .prepare(`UPDATE "${AUTH_TABLES.users}" SET "email_verified" = 1, "updated_at" = ? WHERE "id" = ?`)
          .run(this.now().toISOString(), existing.id)
      }
      return toAuthUser({ ...existing, email_verified: 1 })
    }

    const id = randomUUID()
    const timestamp = this.now().toISOString()

    try {
      this.db
        .prepare(
          `INSERT INTO "${AUTH_TABLES.users}"
             ("id", "email", "password_hash", "role", "email_verified", "created_at", "updated_at")
           VALUES (?, ?, ?, 'user', 1, ?, ?)`,
        )
        .run(id, normalized, '!oauth', timestamp, timestamp)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // Lost a race with another request; read the winner.
      const row = this.db
        .prepare(
          `SELECT "id", "email", "role", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "email" = ?`,
        )
        .get(normalized) as
        | { id: string; email: string; role: AuthRole; email_verified: number }
        | undefined
      if (!row) throw error
      return toAuthUser(row)
    }

    return { id, email: normalized, role: 'user', emailVerified: true }
  }

  async startSession(user: AuthUser): Promise<AuthSessionResult> {
    return this.createSession(user)
  }

  async login(input: Credentials, meta: RequestMeta): Promise<AuthSessionResult> {
    const email = normalizeEmail(input.email)
    const accountKey = `acct:${email}`

    // Count the attempt before doing any expensive work, including for
    // unknown accounts, so throttling cannot be bypassed by guessing emails.
    checkThrottle(this.db, accountKey, this.config.throttle.account, this.now().getTime())
    this.checkIpThrottle(meta.ip)

    const user = this.db
      .prepare(
        `SELECT "id", "email", "password_hash", "role", "email_verified"
         FROM "${AUTH_TABLES.users}" WHERE "email" = ?`,
      )
      .get(email) as UserRow | undefined

    const valid = user
      ? await verifyPassword(user.password_hash, input.password)
      : await verifyDummyPassword(input.password)

    if (!user || !valid) throw unauthorized('Invalid email or password')

    if (this.config.emailVerification.required && user.email_verified !== 1) {
      throw emailNotVerified()
    }

    clearThrottle(this.db, accountKey)
    return this.createSession(toAuthUser(user))
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
                  u."email" AS "email",
                  u."role" AS "role",
                  u."email_verified" AS "email_verified"
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
          user: {
            id: row.userId,
            email: row.email,
            role: row.role,
            emailVerified: row.email_verified === 1,
          },
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
        `SELECT s."user_id" AS "userId", s."id" AS "sessionId",
                u."role" AS "role", u."email_verified" AS "email_verified"
         FROM "${AUTH_TABLES.tokens}" t
         JOIN "${AUTH_TABLES.sessions}" s ON s."id" = t."session_id"
         JOIN "${AUTH_TABLES.users}" u ON u."id" = s."user_id"
         WHERE t."token_hash" = ? AND t."kind" = 'access'
           AND t."expires_at" > ? AND s."expires_at" > ? AND s."revoked_at" IS NULL`,
      )
      .get(hashToken(accessToken), now, now) as
      | { userId: string; sessionId: string; role: AuthRole; email_verified: number }
      | undefined

    if (!row) return null
    return {
      userId: row.userId,
      sessionId: row.sessionId,
      role: row.role,
      emailVerified: row.email_verified === 1,
    }
  }

  userById(id: string): AuthUser | null {
    const row = this.db
      .prepare(
        `SELECT "id", "email", "role", "email_verified" FROM "${AUTH_TABLES.users}" WHERE "id" = ?`,
      )
      .get(id) as { id: string; email: string; role: AuthRole; email_verified: number } | undefined
    return row ? toAuthUser(row) : null
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

function toAuthUser(row: {
  id: string
  email: string
  role: AuthRole
  email_verified: number
}): AuthUser {
  return { id: row.id, email: row.email, role: row.role, emailVerified: row.email_verified === 1 }
}

function withToken(url: string, token: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

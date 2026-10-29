import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import type { AuthService } from '../../auth/service.js'
import { bearerToken } from '../../auth/bearer.js'
import { recordAudit } from '../../audit/log.js'
import type { MungilConfig } from '../../config/schema.js'
import type { Db } from '../../db/connect.js'
import type { Mailer } from '../../email/mailer.js'
import { readJson } from '../body.js'
import { clientIp } from '../client-ip.js'
import { badRequest, unauthorized } from '../errors.js'

const credentialsSchema = z
  .object({
    email: z.string().min(3).max(254),
    password: z.string().min(1).max(1024),
  })
  .strict()

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(256) }).strict()

const resetRequestSchema = z.object({ email: z.string().min(3).max(254) }).strict()

const resetPasswordSchema = z
  .object({ token: z.string().min(1).max(256), password: z.string().min(1).max(1024) })
  .strict()

const verifyEmailSchema = z.object({ token: z.string().min(1).max(256) }).strict()

export interface AuthRoutesDeps {
  service: AuthService
  db: Db
  config: MungilConfig
  mailer?: Mailer
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRoutesDeps): void {
  const { mailer } = deps
  const passwordReset = deps.config.auth?.passwordReset
  const resetUrl =
    passwordReset?.resetUrl ??
    (deps.config.appUrl ? `${deps.config.appUrl.replace(/\/+$/, '')}/reset-password` : null)

  const emailVerification = deps.config.auth?.emailVerification
  const verifyUrl =
    emailVerification?.verifyUrl ??
    (deps.config.appUrl ? `${deps.config.appUrl.replace(/\/+$/, '')}/verify-email` : null)

  app.post('/api/v1/auth/register', async (c) => {
    const credentials = parse(credentialsSchema, await readJson(c))
    const result = await deps.service.register(credentials, { ip: clientIp(c) })

    if (emailVerification?.enabled && mailer && verifyUrl) {
      await deps.service.requestEmailVerification(result.user.id, mailer, {
        verifyUrl,
        ttlSeconds: emailVerification.tokenTtlSeconds,
      })
    }

    recordAudit(deps.db, {
      event: 'auth.register',
      outcome: 'success',
      requestId: c.get('requestId'),
      userId: result.user.id,
    })
    return c.json(result, 201)
  })

  app.post('/api/v1/auth/login', async (c) => {
    const credentials = parse(credentialsSchema, await readJson(c))
    const result = await deps.service.login(credentials, { ip: clientIp(c) })
    recordAudit(deps.db, {
      event: 'auth.login',
      outcome: 'success',
      requestId: c.get('requestId'),
      userId: result.user.id,
    })
    return c.json(result)
  })

  app.post('/api/v1/auth/refresh', async (c) => {
    const body = parse(refreshSchema, await readJson(c))
    const result = deps.service.refresh(body.refreshToken)
    recordAudit(deps.db, {
      event: 'auth.refresh',
      outcome: 'success',
      requestId: c.get('requestId'),
      userId: result.user.id,
    })
    return c.json(result)
  })

  if (passwordReset?.enabled && mailer && resetUrl) {
    app.post('/api/v1/auth/request-password-reset', async (c) => {
      const body = parse(resetRequestSchema, await readJson(c))
      const result = await deps.service.requestPasswordReset(body.email, { ip: clientIp(c) }, mailer, {
        resetUrl,
        ttlSeconds: passwordReset.tokenTtlSeconds,
        maxRequestsPerHour: passwordReset.maxRequestsPerHour,
      })

      recordAudit(deps.db, {
        event: 'auth.password_reset_requested',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: result.userId,
      })

      // Same answer whether or not the address exists.
      return c.json({ status: 'accepted' }, 202)
    })

    app.post('/api/v1/auth/reset-password', async (c) => {
      const body = parse(resetPasswordSchema, await readJson(c))
      const user = await deps.service.resetPassword(body.token, body.password)

      recordAudit(deps.db, {
        event: 'auth.password_reset',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: user.id,
      })

      return c.json({ status: 'ok' })
    })
  }

  if (emailVerification?.enabled && mailer && verifyUrl) {
    app.post('/api/v1/auth/verify-email', async (c) => {
      const body = parse(verifyEmailSchema, await readJson(c))
      const user = deps.service.verifyEmail(body.token)

      recordAudit(deps.db, {
        event: 'auth.email_verified',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: user.id,
      })

      return c.json({ status: 'ok' })
    })

    app.post('/api/v1/auth/resend-verification', async (c) => {
      const { uid } = c.get('auth')
      if (!uid) throw unauthorized()

      const result = await deps.service.resendEmailVerification(
        uid,
        { ip: clientIp(c) },
        mailer,
        {
          verifyUrl,
          ttlSeconds: emailVerification.tokenTtlSeconds,
          maxRequestsPerHour: emailVerification.maxRequestsPerHour,
        },
      )

      recordAudit(deps.db, {
        event: 'auth.verification_sent',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: uid,
        metadata: { sent: result.sent },
      })

      return c.json({ status: 'accepted' }, 202)
    })
  }

  app.post('/api/v1/auth/logout', (c) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token) deps.service.logout(token)
    recordAudit(deps.db, {
      event: 'auth.logout',
      outcome: 'success',
      requestId: c.get('requestId'),
      userId: c.get('auth').uid,
    })
    return c.body(null, 204)
  })

  app.get('/api/v1/auth/me', (c) => {
    const { uid } = c.get('auth')
    if (!uid) throw unauthorized()
    const user = deps.service.userById(uid)
    if (!user) throw unauthorized()
    return c.json(user)
  })
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw badRequest(
      'Invalid input',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '',
        message: issue.message,
      })),
    )
  }
  return result.data
}

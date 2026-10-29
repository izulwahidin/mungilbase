import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import type { AuthService } from '../../auth/service.js'
import { bearerToken } from '../../auth/bearer.js'
import { recordAudit } from '../../audit/log.js'
import type { Db } from '../../db/connect.js'
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

export interface AuthRoutesDeps {
  service: AuthService
  db: Db
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRoutesDeps): void {
  app.post('/api/v1/auth/register', async (c) => {
    const credentials = parse(credentialsSchema, await readJson(c))
    const result = await deps.service.register(credentials, { ip: clientIp(c) })
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

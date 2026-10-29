import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Context } from 'hono'
import type { MungilConfig } from '../config/schema.js'
import type { Db } from '../db/connect.js'
import { anonymous, type AuthContext } from '../auth/context.js'
import { AuthService } from '../auth/service.js'
import { bearerToken } from '../auth/bearer.js'
import { recordAudit } from '../audit/log.js'
import { buildOpenApi } from '../openapi/spec.js'
import { createRegistry, type Registry } from '../tables/registry.js'
import { AppError } from './errors.js'
import { requestId, requestLog } from './middleware.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCrudRoutes } from './routes/crud.js'

export interface AppEnv {
  Variables: {
    requestId: string
    auth: AuthContext
  }
}

export interface AppDeps {
  config: MungilConfig
  version: string
  /** Required for CRUD routes. Health and version work without it. */
  db?: Db
  /** Built from config when omitted; index.ts passes the one it schema-synced. */
  registry?: Registry
  /** Week 7 replaces this with real JWT/session verification. */
  auth?: (c: Context<AppEnv>) => AuthContext | Promise<AuthContext>
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const startedAt = Date.now()
  const registry = deps.registry ?? createRegistry(deps.config)
  const authService = deps.db && deps.config.auth ? new AuthService(deps.db, deps.config.auth) : null

  // A test hook can replace token verification entirely; production uses the
  // DB-backed opaque tokens below.
  const resolveAuth =
    deps.auth ??
    ((c: Context<AppEnv>): AuthContext => {
      if (!authService) return anonymous
      const token = bearerToken(c.req.header('authorization'))
      if (!token) return anonymous
      const session = authService.resolveAccessToken(token)
      return session ? { uid: session.userId, sessionId: session.sessionId } : anonymous
    })

  app.use('*', requestId())
  app.use('*', requestLog())
  app.use('*', secureHeaders())

  app.use('/api/*', async (c, next) => {
    c.set('auth', await resolveAuth(c))
    await next()
  })

  // CORS is closed by default. A browser may only call us from an origin the
  // operator explicitly listed (or from appUrl, which is our own frontend).
  const allowedOrigins = new Set(deps.config.allowedOrigins.map((origin) => new URL(origin).origin))
  if (deps.config.appUrl) allowedOrigins.add(new URL(deps.config.appUrl).origin)

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : undefined),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  )

  // Registered before the table routes: `/api/v1/openapi.json` would
  // otherwise match `/:table`.
  app.get('/api/v1/openapi.json', (c) => c.json(buildOpenApi(deps.config, deps.version)))

  // Auth routes register before CRUD so `/api/v1/auth/*` cannot be shadowed by
  // the `/:table/:id` patterns.
  if (authService && deps.db) registerAuthRoutes(app, { service: authService, db: deps.db })
  if (deps.db) registerCrudRoutes(app, { db: deps.db, registry })

  const auditFailure = (c: Context<AppEnv>, code: string, status: number): void => {
    if (!deps.db) return
    // Only security-relevant outcomes. Validation errors are noise here.
    const interesting =
      code === 'rule_violation' || code === 'rate_limited' || code === 'unauthorized' || status >= 500
    if (!interesting) return

    const match = /^\/api\/v1\/([^/]+)(?:\/([^/]+))?$/.exec(c.req.path)
    const table = match && match[1] !== 'auth' ? match[1] : null
    const resourceId = match?.[2] ?? null
    const auth = c.get('auth') as AuthContext | undefined

    recordAudit(deps.db, {
      event: status >= 500 ? 'http.error' : 'http.denied',
      outcome: code === 'rule_violation' ? 'denied' : 'failure',
      requestId: c.get('requestId'),
      userId: auth?.uid ?? null,
      table,
      operation: operationFor(c.req.method, resourceId),
      resourceId,
      code,
      metadata: { method: c.req.method, path: c.req.path, status },
    })
  }

  app.get('/health', (c) => {
    const base = {
      status: 'ok' as const,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
    try {
      deps.db?.prepare('SELECT 1').get()
      return c.json(base)
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'health_check_failed',
          requestId: c.get('requestId'),
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      return c.json({ ...base, status: 'unavailable' }, 503)
    }
  })

  app.get('/version', (c) => c.json({ version: deps.version }))

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found', request_id: c.get('requestId') } }, 404),
  )

  app.onError((error, c) => {
    const requestIdValue = c.get('requestId')

    if (error instanceof AppError) {
      auditFailure(c, error.code, error.statusCode)
      if (error.code === 'rate_limited') {
        const details = error.details as { retryAfterSeconds?: number } | undefined
        if (typeof details?.retryAfterSeconds === 'number') {
          c.header('Retry-After', String(details.retryAfterSeconds))
        }
      }
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            request_id: requestIdValue,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.statusCode,
      )
    }

    // Never leak internals. Log the stack with the request id instead.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'unhandled_error',
        requestId: requestIdValue,
        method: c.req.method,
        path: c.req.path,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    )

    auditFailure(c, 'internal', 500)

    return c.json(
      { error: { code: 'internal', message: 'Internal server error', request_id: requestIdValue } },
      500 as ContentfulStatusCode,
    )
  })

  return app
}

function operationFor(method: string, resourceId: string | null): string | null {
  switch (method) {
    case 'GET':
      return resourceId ? 'view' : 'list'
    case 'POST':
      return 'create'
    case 'PATCH':
    case 'PUT':
      return 'update'
    case 'DELETE':
      return 'delete'
    default:
      return null
  }
}

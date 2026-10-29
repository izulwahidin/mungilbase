import { timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../app.js'
import type { AuthUser, AuthService } from '../../auth/service.js'
import { createToken } from '../../auth/tokens.js'
import { recordAudit } from '../../audit/log.js'
import type { MungilConfig } from '../../config/schema.js'
import type { Db } from '../../db/connect.js'
import type { RegisteredTable, Registry } from '../../tables/registry.js'
import type { AuthContext } from '../../auth/context.js'
import { createRow, deleteRow, listRows, updateRow, viewRow } from '../../tables/crud.js'
import { AppError, badRequest, forbidden, notFound } from '../errors.js'
import { clientIp } from '../client-ip.js'
import { dashboardPage, errorPage, listPage, loginPage, recordPage } from '../../admin/html.js'

const ADMIN_COOKIE = 'mungil_admin'
const CSRF_COOKIE = 'mungil_csrf'
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export interface AdminRoutesDeps {
  service: AuthService
  db: Db
  registry: Registry
  config: MungilConfig
}

/**
 * Server-rendered admin panel.
 *
 * - Its own cookie session, not an access token.
 * - Requires the `admin` role; still answers rules unless
 *   `auth.adminBypassRules` is enabled.
 * - Every POST is CSRF-checked with a double-submit token.
 * - All row access goes through the same CRUD functions as the API, so there
 *   is no second, unaudited query path.
 */
export function registerAdminRoutes(parent: Hono<AppEnv>, deps: AdminRoutesDeps): void {
  const app = new Hono<AppEnv>()
  const sessionTtl = deps.config.auth?.adminSessionTtlSeconds ?? 28_800
  const secure = deps.config.appUrl?.startsWith('https://') ?? false
  const cookieOptions = { path: '/admin', httpOnly: true, sameSite: 'Lax' as const, secure }

  const adminContext = (user: AuthUser): AuthContext => ({
    uid: user.id,
    role: user.role,
    admin: deps.config.auth?.adminBypassRules ?? false,
  })

  const currentUser = (c: Parameters<typeof getCookie>[0]): AuthUser | null => {
    const token = getCookie(c, ADMIN_COOKIE)
    return token ? deps.service.resolveAdminSession(token) : null
  }

  const csrfToken = (c: Parameters<typeof getCookie>[0]): string => {
    const existing = getCookie(c, CSRF_COOKIE)
    if (existing) return existing
    const token = createToken()
    setCookie(c, CSRF_COOKIE, token, { ...cookieOptions, maxAge: sessionTtl })
    return token
  }

  const requireUser = (c: Parameters<typeof getCookie>[0]): AuthUser | null => currentUser(c)

  const tableOrThrow = (name: string): RegisteredTable => {
    const table = deps.registry.get(name)
    if (!table) throw notFound(`Unknown table "${name}"`)
    return table
  }

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.html(errorPage(error.message), error.statusCode)
    }
    throw error
  })

  app.notFound((c) => c.html(errorPage('Not found'), 404))

  app.get('/', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)
    const tables = [...deps.registry.tables.keys()].sort()
    return c.html(dashboardPage(tables, csrfToken(c), user.email))
  })

  app.get('/login', (c) => {
    if (currentUser(c)) return c.redirect('/admin', 303)
    return c.html(loginPage(csrfToken(c)))
  })

  app.post('/login', async (c) => {
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''

    try {
      const session = await deps.service.login({ email, password }, { ip: clientIp(c) })
      // The API session is not needed for the panel; never leave it around.
      deps.service.logout(session.tokens.accessToken)

      if (session.user.role !== 'admin') {
        return c.html(loginPage(csrfToken(c), 'This account is not an administrator'), 403)
      }

      const token = await deps.service.createAdminSession(session.user.id, sessionTtl)
      setCookie(c, ADMIN_COOKIE, token, { ...cookieOptions, maxAge: sessionTtl })
      recordAudit(deps.db, {
        event: 'auth.admin_login',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: session.user.id,
      })
      return c.redirect('/admin', 303)
    } catch (error) {
      if (error instanceof AppError) {
        return c.html(loginPage(csrfToken(c), error.message), error.statusCode)
      }
      throw error
    }
  })

  app.post('/logout', async (c) => {
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const user = currentUser(c)
    const token = getCookie(c, ADMIN_COOKIE)
    if (token) deps.service.revokeAdminSession(token)
    deleteCookie(c, ADMIN_COOKIE, { path: '/admin' })
    if (user) {
      recordAudit(deps.db, {
        event: 'auth.admin_logout',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: user.id,
      })
    }
    return c.redirect('/admin/login', 303)
  })

  app.get('/tables/:table', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const limit = clamp(Number(c.req.query('limit') ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE)
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)

    const { items } = listRows(deps.db, table, adminContext(user), { limit, offset })
    return c.html(listPage(table, items, { limit, offset }, csrfToken(c), user.email))
  })

  app.get('/tables/:table/new', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    return c.html(recordPage(tableOrThrow(c.req.param('table')), null, csrfToken(c)))
  })

  app.post('/tables/:table', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    const values = formValues(table, body)
    try {
      const row = createRow(deps.db, table, adminContext(user), values)
      auditWrite(c, deps, user, 'admin.create', table.name, 'create', String(row.id))
      return c.redirect(`/admin/tables/${encodeURIComponent(table.name)}`, 303)
    } catch (error) {
      if (error instanceof AppError) {
        return c.html(recordPage(table, values, csrfToken(c), error.message), error.statusCode)
      }
      throw error
    }
  })

  app.get('/tables/:table/:id', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const row = viewRow(deps.db, table, adminContext(user), c.req.param('id'))
    return c.html(recordPage(table, row, csrfToken(c)))
  })

  app.post('/tables/:table/:id', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const id = c.req.param('id')
    const values = formValues(table, body)

    try {
      updateRow(deps.db, table, adminContext(user), id, values)
      auditWrite(c, deps, user, 'admin.update', table.name, 'update', id)
      return c.redirect(`/admin/tables/${encodeURIComponent(table.name)}`, 303)
    } catch (error) {
      if (error instanceof AppError) {
        const row = { ...values, id }
        return c.html(recordPage(table, row, csrfToken(c), error.message), error.statusCode)
      }
      throw error
    }
  })

  app.post('/tables/:table/:id/delete', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const id = c.req.param('id')

    deleteRow(deps.db, table, adminContext(user), id)
    auditWrite(c, deps, user, 'admin.delete', table.name, 'delete', id)
    return c.redirect(`/admin/tables/${encodeURIComponent(table.name)}`, 303)
  })

  parent.route('/admin', app)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function assertCsrf(c: Parameters<typeof getCookie>[0], body: Record<string, string | File>): void {
  const cookie = getCookie(c, CSRF_COOKIE)
  const provided = typeof body._csrf === 'string' ? body._csrf : ''
  if (!cookie || !provided) throw forbidden('Invalid CSRF token')

  const a = Buffer.from(cookie)
  const b = Buffer.from(provided)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden('Invalid CSRF token')
}

/** Converts HTML form strings into the JSON types the CRUD layer expects. */
function formValues(
  table: RegisteredTable,
  body: Record<string, string | File>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}

  for (const field of table.config.fields) {
    const raw = body[`f_${field.name}`]
    if (raw === undefined) continue
    if (typeof raw !== 'string') throw badRequest('File uploads are not supported yet')

    if (field.type === 'boolean') {
      values[field.name] = raw === 'true'
      continue
    }

    if (field.type === 'integer' || field.type === 'real') {
      values[field.name] = raw.trim() === '' ? null : Number(raw)
      continue
    }

    if (field.type === 'json') {
      if (raw.trim() === '') {
        values[field.name] = null
        continue
      }
      try {
        values[field.name] = JSON.parse(raw) as unknown
      } catch {
        throw badRequest(`${field.name} must be valid JSON`)
      }
      continue
    }

    values[field.name] = raw === '' ? null : raw
  }

  return values
}

function auditWrite(
  c: Context<AppEnv>,
  deps: AdminRoutesDeps,
  user: AuthUser,
  event: string,
  table: string,
  operation: string,
  id: string,
): void {
  recordAudit(deps.db, {
    event,
    outcome: 'success',
    requestId: c.get('requestId'),
    userId: user.id,
    table,
    operation,
    resourceId: id,
  })
}

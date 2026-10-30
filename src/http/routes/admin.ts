import { timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from '../app.js'
import type { AuthUser, AuthService } from '../../auth/service.js'
import { createToken } from '../../auth/tokens.js'
import { recordAudit } from '../../audit/log.js'
import type { FieldConfig, MungilConfig, TableConfig } from '../../config/schema.js'
import { configSchema } from '../../config/schema.js'
import { loadConfigFile } from '../../config/load.js'
import { writeConfigFile } from '../../config/write.js'
import type { Db } from '../../db/connect.js'
import { ensureSchema } from '../../db/ddl.js'
import {
  createRegistry,
  SchemaError,
  type RegisteredTable,
  type Registry,
} from '../../tables/registry.js'
import type { AuthContext } from '../../auth/context.js'
import { createRow, deleteRow, listRows, updateRow, viewRow } from '../../tables/crud.js'
import {
  cleanupReplacedFiles,
  deleteStoredFiles,
  fileKeysForRow,
  fileKeysInRow,
} from '../../tables/files.js'
import type { Storage } from '../../storage/storage.js'
import { AppError, badRequest, forbidden, notFound } from '../errors.js'
import { clientIp } from '../client-ip.js'
import {
  dashboardPage,
  errorPage,
  listPage,
  loginPage,
  recordPage,
  settingsPage,
  setupPage,
} from '../../admin/html.js'
import { blankTable, schemaFormPage, schemaPage } from '../../admin/schema.js'
import { ADMIN_CSS, ADMIN_JS } from '../../admin/layout.js'

const ADMIN_COOKIE = 'mungil_admin'
const CSRF_COOKIE = 'mungil_csrf'
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

type Body = Record<string, string | File>

export interface AdminRoutesDeps {
  service: AuthService
  db: Db
  registry: Registry
  config: MungilConfig
  storage: Storage
  /** Absolute path of the config file. When omitted the schema editor is read-only. */
  configPath?: string
  version: string
  dbFile?: string
}

/**
 * Server-rendered admin panel.
 *
 * - Its own cookie session, not an access token.
 * - Requires the `admin` role; still answers rules unless
 *   `auth.adminBypassRules` is enabled.
 * - While no admin account exists, `/admin/setup` creates the first one.
 * - Every POST is CSRF-checked with a double-submit token.
 * - Row access goes through the same CRUD functions as the API. Schema edits
 *   go through the same validation, DDL and registry the server booted with,
 *   and are written back to the config file.
 */
export function registerAdminRoutes(parent: Hono<AppEnv>, deps: AdminRoutesDeps): void {
  const app = new Hono<AppEnv>()

  // Forms carry CSRF tokens and row data. Never let a proxy or the browser
  // replay them from cache.
  app.use('*', async (c, next) => {
    await next()
    c.header('cache-control', 'no-store')
  })

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

  const setupOpen = (): boolean => !deps.service.hasAdminAccount()

  const tableOrThrow = (name: string): RegisteredTable => {
    const table = deps.registry.get(name)
    if (!table) throw notFound(`Unknown table "${name}"`)
    return table
  }

  const sortedTables = (): RegisteredTable[] =>
    [...deps.registry.tables.values()].sort((left, right) => left.name.localeCompare(right.name))

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.html(errorPage(error.message, currentUser(c)), error.statusCode)
    }
    throw error
  })

  app.notFound((c) => c.html(errorPage('Not found', currentUser(c)), 404))

  /* Static assets ---------------------------------------------------------- */

  const asset = (c: Context<AppEnv>, body: string, contentType: string): Response =>
    c.body(body, 200, { 'content-type': contentType })

  app.get('/assets/app.css', (c) => asset(c, ADMIN_CSS, 'text/css; charset=utf-8'))
  app.get('/assets/app.js', (c) => asset(c, ADMIN_JS, 'text/javascript; charset=utf-8'))

  /* First-run setup -------------------------------------------------------- */

  app.get('/setup', (c) => {
    if (!setupOpen()) return c.redirect(currentUser(c) ? '/admin' : '/admin/login', 303)
    return c.html(setupPage(csrfToken(c)))
  })

  app.post('/setup', async (c) => {
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    if (!setupOpen()) {
      return c.redirect('/admin/login', 303)
    }

    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const confirm = typeof body.confirm === 'string' ? body.confirm : ''

    if (password !== confirm) {
      return c.html(setupPage(csrfToken(c), { error: 'The passwords do not match', email }), 400)
    }

    try {
      const user = await deps.service.createUser({ email, password }, 'admin')

      // Two visitors can race the same empty deployment. Both may insert an
      // admin; only the oldest account survives, so exactly one remains and
      // neither request deletes the other's winner.
      if (deps.service.firstAdminId() !== user.id) {
        await deps.service.deleteUser(user.email)
        return c.html(
          setupPage(csrfToken(c), { error: 'An administrator already exists. Sign in instead.', email }),
          409,
        )
      }

      const token = await deps.service.createAdminSession(user.id, sessionTtl)
      setCookie(c, ADMIN_COOKIE, token, { ...cookieOptions, maxAge: sessionTtl })
      recordAudit(deps.db, {
        event: 'auth.admin_setup',
        outcome: 'success',
        requestId: c.get('requestId'),
        userId: user.id,
      })
      return c.redirect('/admin', 303)
    } catch (error) {
      if (error instanceof AppError) {
        return c.html(setupPage(csrfToken(c), { error: error.message, email }), error.statusCode)
      }
      throw error
    }
  })

  /* Login and logout ------------------------------------------------------- */

  app.get('/', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)
    return c.html(
      dashboardPage(sortedTables(), csrfToken(c), user, c.req.query('saved')),
    )
  })

  app.get('/login', (c) => {
    if (setupOpen()) return c.redirect('/admin/setup', 303)
    if (currentUser(c)) return c.redirect('/admin', 303)
    return c.html(loginPage(csrfToken(c)))
  })

  app.post('/login', async (c) => {
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    if (setupOpen()) return c.redirect('/admin/setup', 303)

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

  /* Row data --------------------------------------------------------------- */

  app.get('/tables/:table', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const limit = clamp(Number(c.req.query('limit') ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE)
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)

    const { items } = listRows(deps.db, table, adminContext(user), { limit, offset })
    return c.html(
      listPage(table, items, { limit, offset }, csrfToken(c), user, c.req.query('saved')),
    )
  })

  app.get('/tables/:table/new', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    return c.html(recordPage(tableOrThrow(c.req.param('table')), null, csrfToken(c), undefined, user))
  })

  app.post('/tables/:table', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    const values = formValues(table, body)
    try {
      const row = createRow(deps.db, table, adminContext(user), values)
      auditWrite(c, deps, user, 'admin.create', table.name, 'create', String(row.id))
      return c.redirect(
        `/admin/tables/${encodeURIComponent(table.name)}?saved=${encodeURIComponent('Row created')}`,
        303,
      )
    } catch (error) {
      if (error instanceof AppError) {
        return c.html(recordPage(table, values, csrfToken(c), error.message, user), error.statusCode)
      }
      throw error
    }
  })

  app.get('/tables/:table/:id', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const row = viewRow(deps.db, table, adminContext(user), c.req.param('id'))
    return c.html(recordPage(table, row, csrfToken(c), undefined, user))
  })

  app.post('/tables/:table/:id', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const id = c.req.param('id')
    const values = formValues(table, body)
    const previousKeys = fileKeysForRow(deps.db, table, id)

    try {
      const row = updateRow(deps.db, table, adminContext(user), id, values)
      await cleanupReplacedFiles(deps.storage, table, previousKeys, row)
      auditWrite(c, deps, user, 'admin.update', table.name, 'update', id)
      return c.redirect(
        `/admin/tables/${encodeURIComponent(table.name)}?saved=${encodeURIComponent('Row saved')}`,
        303,
      )
    } catch (error) {
      if (error instanceof AppError) {
        const row = { ...values, id }
        return c.html(recordPage(table, row, csrfToken(c), error.message, user), error.statusCode)
      }
      throw error
    }
  })

  app.post('/tables/:table/:id/delete', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    const body = await c.req.parseBody()
    assertCsrf(c, body)
    const id = c.req.param('id')

    const deleted = deleteRow(deps.db, table, adminContext(user), id)
    await deleteStoredFiles(deps.storage, fileKeysInRow(table, deleted))
    auditWrite(c, deps, user, 'admin.delete', table.name, 'delete', id)
    return c.redirect(
      `/admin/tables/${encodeURIComponent(table.name)}?saved=${encodeURIComponent('Row deleted')}`,
      303,
    )
  })

  /* Settings --------------------------------------------------------------- */

  app.get('/settings', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    return c.html(
      settingsPage(
        {
          config: deps.config,
          configPath: deps.configPath,
          version: deps.version,
          dbFile: deps.dbFile,
          tableCount: deps.registry.tables.size,
        },
        csrfToken(c),
        user,
      ),
    )
  })

  /* Schema editor ---------------------------------------------------------- */

  app.get('/schema', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    return c.html(
      schemaPage(sortedTables(), csrfToken(c), user, {
        writable: Boolean(deps.configPath),
        configPath: deps.configPath,
        message: c.req.query('saved'),
      }),
    )
  })

  app.get('/schema/new', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    return c.html(
      schemaFormPage({
        table: blankTable(),
        isNew: true,
        knownTables: [...deps.registry.tables.keys()],
        csrf: csrfToken(c),
        user,
        writable: Boolean(deps.configPath),
        configPath: deps.configPath,
      }),
    )
  })

  app.get('/schema/:table', (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const table = tableOrThrow(c.req.param('table'))
    return c.html(
      schemaFormPage({
        table: table.config,
        isNew: false,
        knownTables: [...deps.registry.tables.keys()],
        csrf: csrfToken(c),
        user,
        writable: Boolean(deps.configPath),
        configPath: deps.configPath,
      }),
    )
  })

  app.post('/schema', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const body = await c.req.parseBody()
    assertCsrf(c, body)

    const rendered = (issues: string[], draft: TableConfig): string =>
      schemaFormPage({
        table: draft,
        isNew: true,
        knownTables: [...deps.registry.tables.keys()],
        csrf: csrfToken(c),
        user,
        writable: Boolean(deps.configPath),
        configPath: deps.configPath,
        issues,
      })

    const { draft, issues } = tableFromForm(body, '', true)
    if (issues.length) return c.html(rendered(issues, draft), 400)
    if (deps.registry.tables.has(draft.name)) {
      return c.html(rendered([`A table named "${draft.name}" already exists`], draft), 400)
    }

    return applySchema(c, user, [...currentTables(), draft], (problems) =>
      c.html(rendered(problems, draft), problems.length ? 400 : 500),
    )
  })

  app.post('/schema/:table', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const name = c.req.param('table')
    const existing = tableOrThrow(name)
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    const rendered = (issues: string[], draft: TableConfig): string =>
      schemaFormPage({
        table: draft,
        isNew: false,
        knownTables: [...deps.registry.tables.keys()],
        csrf: csrfToken(c),
        user,
        writable: Boolean(deps.configPath),
        configPath: deps.configPath,
        issues,
      })

    const { draft, issues } = tableFromForm(body, name, false, existing.config)
    if (issues.length) return c.html(rendered(issues, draft), 400)

    const tables = currentTables().map((table) => (table.name === name ? draft : table))
    return applySchema(c, user, tables, (problems) =>
      c.html(rendered(problems, draft), problems.length ? 400 : 500),
    )
  })

  app.post('/schema/:table/delete', async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect(setupOpen() ? '/admin/setup' : '/admin/login', 303)

    const name = c.req.param('table')
    tableOrThrow(name)
    const body = await c.req.parseBody()
    assertCsrf(c, body)

    return applySchema(
      c,
      user,
      currentTables().filter((table) => table.name !== name),
      (problems) => c.html(errorPage(problems.join(' '), user), 400),
      `/admin/schema?saved=${encodeURIComponent(`Removed ${name}`)}`,
    )
  })

  /* Shared schema save ----------------------------------------------------- */

  const currentTables = (): TableConfig[] => [...deps.registry.tables.values()].map((table) => table.config)

  /**
   * Validates a candidate table list, applies the additive DDL, writes the
   * config file, and only then swaps the live registry. Every step can fail
   * without leaving the running server with a schema it has not validated.
   */
  async function applySchema(
    c: Context<AppEnv>,
    user: AuthUser,
    tables: TableConfig[],
    onFailure: (problems: string[]) => Response,
    redirectTo = '/admin/schema',
  ): Promise<Response> {
    if (!deps.configPath) {
      return c.html(
        errorPage(
          'This server has no config file path, so the schema editor is read-only. ' +
            'Call createApp({ configPath }) or edit the config file directly.',
          user,
        ),
        409,
      )
    }

    let base: Awaited<ReturnType<typeof loadConfigFile>>
    try {
      base = await loadConfigFile(deps.configPath)
    } catch (error) {
      return c.html(
        errorPage(
          `Could not read the config file: ${error instanceof Error ? error.message : String(error)}`,
          user,
        ),
        500,
      )
    }

    const candidate = configSchema.safeParse({ ...base.raw, tables })
    if (!candidate.success) {
      return onFailure(candidate.error.issues.map(formatIssue))
    }

    let next: Registry
    try {
      next = createRegistry(candidate.data)
    } catch (error) {
      if (error instanceof SchemaError) return onFailure([error.message])
      throw error
    }

    try {
      ensureSchema(deps.db, next)
    } catch (error) {
      if (error instanceof SchemaError) return onFailure([error.message])
      throw error
    }

    try {
      await writeConfigFile(deps.configPath, { ...base.raw, tables: candidate.data.tables })
    } catch (error) {
      return onFailure([
        `The database change was applied, but writing ${deps.configPath} failed: ` +
          `${error instanceof Error ? error.message : String(error)}. Fix the file permissions and save again.`,
      ])
    }

    deps.registry.replace(candidate.data)
    deps.config.tables = candidate.data.tables
    recordAudit(deps.db, {
      event: 'admin.schema_update',
      outcome: 'success',
      requestId: c.get('requestId'),
      userId: user.id,
      metadata: { tables: candidate.data.tables.map((table) => table.name) },
    })

    return c.redirect(redirectTo, 303)
  }

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

/* Schema form parsing ------------------------------------------------------ */

function allStrings(body: Body, key: string): string[] {
  // Repeated inputs are named `key[]`, which is how Hono collects arrays from
  // a form post. A single input still arrives as a plain string.
  const raw = body[`${key}[]`] ?? body[key]
  if (raw === undefined) return []
  const values = Array.isArray(raw) ? raw : [raw]
  return values.map((value) => (typeof value === 'string' ? value : ''))
}

/** Human wording for a zod issue on the `tables` array. */
function formatIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  const path = [...issue.path]
  const parts: string[] = []

  if (path[0] === 'tables') {
    path.shift()
    if (typeof path[0] === 'number') path.shift()
  }

  if (path[0] === 'fields' && typeof path[1] === 'number') {
    parts.push(`Field ${path[1] + 1}`)
    path.splice(0, 2)
  } else if (path[0] === 'rules' && typeof path[1] === 'string') {
    parts.push(`Rule "${path[1]}"`)
    path.splice(0, 2)
  } else if (path[0] === 'indexes' && typeof path[1] === 'number') {
    parts.push(`Index ${path[1] + 1}`)
    path.splice(0, 2)
  }

  if (path.length) parts.push(path.join('.'))
  return `${parts.length ? `${parts.join(' · ')}: ` : ''}${issue.message}`
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function tableFromForm(
  body: Body,
  name: string,
  isNew: boolean,
  existing?: TableConfig,
): { draft: TableConfig; issues: string[] } {
  const issues: string[] = []
  const draft: TableConfig = existing
    ? structuredClone(existing)
    : blankTable()

  draft.name = isNew ? allStrings(body, 'name')[0]?.trim() ?? '' : name
  if (isNew && !draft.name) issues.push('The table needs a name')

  draft.timestamps = (allStrings(body, 'timestamps')[0] ?? 'on') === 'on'

  const indexLines = (allStrings(body, 'indexes')[0] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  draft.indexes = indexLines.map((line) => {
    const columns = splitList(line)
    return columns.length === 1 ? columns[0]! : columns
  })

  const names = allStrings(body, 'field_name')
  const types = allStrings(body, 'field_type')
  const required = allStrings(body, 'field_required')
  const unique = allStrings(body, 'field_unique')
  const defaults = allStrings(body, 'field_default')
  const refTables = allStrings(body, 'field_ref_table')
  const refColumns = allStrings(body, 'field_ref_column')
  const maxBytes = allStrings(body, 'field_max_bytes')
  const allowed = allStrings(body, 'field_allowed_types')

  // The draft is pre-validation: `maxBytes`/`allowedTypes` only exist for
  // file fields, and are omitted from the config file otherwise.
  type DraftField = Omit<FieldConfig, 'maxBytes' | 'allowedTypes'> & Partial<FieldConfig>
  const fields: DraftField[] = []

  names.forEach((rawName, index) => {
    const fieldName = rawName.trim()
    if (!fieldName) return

    const type = (types[index] ?? 'text') as FieldConfig['type']
    if (!FIELD_TYPES.has(type)) {
      issues.push(`Field ${index + 1}: unknown type "${String(type)}"`)
      return
    }

    // File options stay out of the draft (and therefore the config file)
    // unless the field actually stores a file.
    const field: DraftField = {
      name: fieldName,
      type,
      required: required[index] === '1',
      unique: unique[index] === '1',
    }

    const rawDefault = defaults[index] ?? ''

    if (rawDefault !== '') {
      const parsedDefault = parseDefault(type, rawDefault)
      if (parsedDefault.ok) {
        if (parsedDefault.value !== undefined) field.default = parsedDefault.value
      } else {
        issues.push(`Field ${index + 1} (${fieldName}): ${parsedDefault.message}`)
      }
    }

    if (type === 'file') {
      const bytes = Number(maxBytes[index] ?? '')
      if (Number.isInteger(bytes) && bytes > 0) field.maxBytes = bytes
      const prefixes = splitList(allowed[index] ?? '')
      field.allowedTypes = prefixes.length ? prefixes : ['image/']
    }

    const referenceTable = (refTables[index] ?? '').trim()
    if (referenceTable) {
      field.references = { table: referenceTable, column: (refColumns[index] ?? '').trim() || 'id' }
    }

    fields.push(field)
  })

  if (!fields.length) issues.push('A table needs at least one field')
  draft.fields = fields as TableConfig['fields']

  for (const operation of RULE_OPERATIONS) {
    const raw = (allStrings(body, `rule_${operation}`)[0] ?? '').trim()
    if (raw === '') {
      issues.push(`Rule "${operation}" is empty. Use "null" to deny or "true" to allow everyone`)
      continue
    }
    draft.rules[operation] = raw === 'null' ? null : raw
  }

  return { draft, issues }
}

const FIELD_TYPES = new Set<string>(['text', 'integer', 'real', 'boolean', 'json', 'date', 'file'])
const RULE_OPERATIONS = ['list', 'view', 'create', 'update', 'delete'] as const

type ParsedDefault =
  | { ok: true; value: string | number | boolean | null | undefined }
  | { ok: false; message: string }

function parseDefault(type: FieldConfig['type'], raw: string): ParsedDefault {
  const value = raw.trim()

  switch (type) {
    case 'boolean':
      if (value === 'true') return { ok: true, value: true }
      if (value === 'false') return { ok: true, value: false }
      return { ok: false, message: 'default must be true or false' }
    case 'integer': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) return { ok: false, message: 'default must be a whole number' }
      return { ok: true, value: parsed }
    }
    case 'real': {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return { ok: false, message: 'default must be a number' }
      return { ok: true, value: parsed }
    }
    case 'json': {
      let parsed: unknown
      try {
        parsed = JSON.parse(value) as unknown
      } catch {
        return { ok: false, message: 'default must be valid JSON' }
      }
      // The config schema allows only literal defaults, so an object or array
      // is rejected here with a clearer message than a nested zod issue.
      if (parsed !== null && typeof parsed === 'object') {
        return { ok: false, message: 'a json default must be a string, number, boolean or null' }
      }
      return { ok: true, value: parsed as string | number | boolean | null }
    }
    default:
      return { ok: true, value }
  }
}

/* Audit ------------------------------------------------------------------- */

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

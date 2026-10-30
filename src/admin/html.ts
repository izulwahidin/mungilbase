import { OPERATIONS } from '../tables/registry.js'
import type { RegisteredTable } from '../tables/registry.js'
import type { MungilConfig } from '../config/schema.js'
import { alert, badge, escapeHtml, icon, logoSvg, renderPage } from './layout.js'

export { escapeHtml } from './layout.js'

interface AdminUser {
  email: string
  role: string
}

function ruleBadges(table: RegisteredTable): string {
  return OPERATIONS.map((operation) => {
    const rule = table.rules[operation]
    const tone = rule === null ? 'off' : rule === 'true' ? 'ok' : 'accent'
    return `<span class="badge ${tone}" title="${escapeHtml(`${operation}: ${String(rule ?? 'null')}`)}">${operation}</span>`
  }).join('')
}

function fieldCount(table: RegisteredTable): string {
  const count = table.config.fields.length
  return `${count} field${count === 1 ? '' : 's'}`
}

/* Login and first-run setup ------------------------------------------------ */

function authCard(body: string): string {
  return drawBare(
    `<div class="auth-wrap"><div class="auth-card">
      <div class="auth-brand">
        ${logoSvg(34)}
        <span><strong>MungilBase</strong><small>Admin panel</small></span>
      </div>
      ${body}
    </div></div>`,
  )
}

function drawBare(body: string): string {
  return renderPage({ title: 'Admin', body, bare: true })
}

export function loginPage(csrf: string, error?: string): string {
  return authCard(
    `<h1>Sign in</h1>
     <p class="sub">Only accounts with the <code>admin</code> role can open this panel.</p>
     ${error ? alert('error', escapeHtml(error)) : ''}
     <form method="post" action="/admin/login">
       <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
       <div class="field">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="username" required autofocus>
       </div>
       <div class="field">
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" required>
       </div>
       <div class="actions"><button type="submit" class="btn btn-primary">Sign in ${icon('chevronRight')}</button></div>
     </form>`,
  )
}

export function setupPage(
  csrf: string,
  options: { error?: string; issues?: string[]; email?: string } = {},
): string {
  const issues = options.issues?.length
    ? `<ul>${options.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
    : ''

  return authCard(
    `<h1>Create the administrator</h1>
     <p class="sub">This deployment has no <code>admin</code> account yet, so this page is open once.
     The account you create here can manage data and the schema.</p>
     ${options.error ? alert('error', `${escapeHtml(options.error)}${issues}`) : ''}
     <form method="post" action="/admin/setup">
       <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
       <div class="field">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="username" required autofocus
                value="${escapeHtml(options.email ?? '')}">
       </div>
       <div class="field">
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
         <span class="hint">At least the configured minimum length (10 characters by default).</span>
       </div>
       <div class="field">
         <label for="confirm">Repeat password</label>
         <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="8">
       </div>
       <div class="actions"><button type="submit" class="btn btn-primary">Create administrator ${icon('chevronRight')}</button></div>
     </form>
     <p class="hint" style="margin-top:1rem">After this account exists the page closes and only
     <a href="/admin/login">sign in</a> remains.</p>`,
  )
}

/* Dashboard --------------------------------------------------------------- */

export function dashboardPage(
  tables: readonly RegisteredTable[],
  csrf: string,
  user: AdminUser,
  message?: string,
): string {
  const tiles = tables
    .map((table) => {
      const timestamp = table.config.timestamps ? badge('timestamps') : ''
      const indexes = table.config.indexes.length ? badge(`${table.config.indexes.length} indexes`) : ''
      return `<a class="tile" href="/admin/tables/${encodeURIComponent(table.name)}">
        <div class="tile-title">${icon('table')}${escapeHtml(table.name)}</div>
        <div class="meta">
          ${badge(fieldCount(table))}${timestamp}${indexes}
        </div>
        <div class="meta">${ruleBadges(table)}</div>
      </a>`
    })
    .join('')

  const body = tables.length
    ? `<div class="grid">${tiles}</div>`
    : `<div class="card card-body empty">
        ${icon('database')}
        <h3>No tables yet</h3>
        <p>A table is a small set of fields plus five access rules. Define the first one here and it
        is written to your config file and created in SQLite immediately.</p>
        <a class="btn btn-primary" href="/admin/schema/new">${icon('plus')}New table</a>
      </div>`

  return renderPage({
    title: 'Data',
    user,
    csrf,
    active: 'tables',
    wide: true,
    body: `${
      message
        ? `<div data-flash>${alert('ok', escapeHtml(message))}</div>`
        : ''
    }
    <div class="page-head">
      <div>
        <h1>Data</h1>
        <p class="sub">Every table in the config, newest first. Row access still honours each table's rules.</p>
      </div>
      <div class="page-actions">
        <a class="btn" href="/admin/schema">${icon('sliders')}Schema</a>
        <a class="btn btn-primary" href="/admin/schema/new">${icon('plus')}New table</a>
      </div>
    </div>
    ${body}
    <p class="hint" style="margin-top:1rem">
      Badges under each table show the five rules: <span class="badge ok">green</span> public,
      <span class="badge accent">indigo</span> conditional, <span class="badge off">grey</span> denied.
    </p>`,
  })
}

/* Row list ---------------------------------------------------------------- */

function cell(value: unknown): string {
  if (value === null || value === undefined) return '<span class="muted">null</span>'
  if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`
  const text = String(value)
  return text.length > 120
    ? `<span title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 117))}…</span>`
    : escapeHtml(text)
}

export function listPage(
  table: RegisteredTable,
  rows: Record<string, unknown>[],
  page: { limit: number; offset: number },
  csrf: string,
  user: AdminUser,
  message?: string,
): string {
  const columns = new Set<string>(['id'])
  for (const field of table.config.fields) columns.add(field.name)
  if (table.config.timestamps) {
    columns.add('created_at')
    columns.add('updated_at')
  }

  const header = [...columns]
    .map((column) => {
      const field = table.config.fields.find((candidate) => candidate.name === column)
      return `<th>${escapeHtml(column)}${
        field ? `<span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0"> · ${escapeHtml(field.type)}</span>` : ''
      }</th>`
    })
    .join('')

  const body = rows
    .map((row) => {
      const cells = [...columns]
        .map((column) => {
          if (column !== 'id') return `<td>${cell(row[column])}</td>`
          const id = String(row.id)
          return `<td class="nowrap"><a href="/admin/tables/${encodeURIComponent(table.name)}/${encodeURIComponent(id)}"><code>${escapeHtml(id.slice(0, 8))}…</code></a></td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  const previous =
    page.offset > 0
      ? `<a class="btn btn-sm" href="?limit=${page.limit}&offset=${Math.max(0, page.offset - page.limit)}">${icon('chevronLeft')}Previous</a>`
      : `<span class="btn btn-sm" aria-disabled="true" style="opacity:.5">${icon('chevronLeft')}Previous</span>`
  const next =
    rows.length === page.limit
      ? `<a class="btn btn-sm" href="?limit=${page.limit}&offset=${page.offset + page.limit}">Next${icon('chevronRight')}</a>`
      : `<span class="btn btn-sm" aria-disabled="true" style="opacity:.5">Next${icon('chevronRight')}</span>`

  return renderPage({
    title: table.name,
    user,
    csrf,
    active: 'tables',
    wide: true,
    breadcrumbs: [{ label: 'Data', href: '/admin' }, { label: table.name }],
    body: `${message ? `<div data-flash>${alert('ok', escapeHtml(message))}</div>` : ''}
    <div class="page-head">
      <div>
        <h1>${escapeHtml(table.name)}</h1>
        <p class="sub">${escapeHtml(fieldCount(table))} · ${escapeHtml(table.config.timestamps ? 'timestamps on' : 'no timestamps')}</p>
        <div class="actions" style="margin-top:.5rem">${ruleBadges(table)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/admin/schema/${encodeURIComponent(table.name)}">${icon('sliders')}Edit schema</a>
        <a class="btn btn-primary" href="/admin/tables/${encodeURIComponent(table.name)}/new">${icon('plus')}New row</a>
      </div>
    </div>
    ${
      rows.length
        ? `<div class="table-wrap"><table class="data"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`
        : `<div class="card card-body empty">
            ${icon('database')}
            <h3>No visible rows</h3>
            <p>The table is empty, or its <code>list</code> rule hides every row from your account.</p>
            <a class="btn btn-primary" href="/admin/tables/${encodeURIComponent(table.name)}/new">${icon('plus')}Create the first row</a>
          </div>`
    }
    <div class="pager">
      <span>Showing ${rows.length} row${rows.length === 1 ? '' : 's'} from offset ${page.offset}</span>
      ${previous}${next}
    </div>`,
  })
}

/* Row form ---------------------------------------------------------------- */

function formField(field: RegisteredTable['config']['fields'][number], value: unknown): string {
  const id = `f_${field.name}`
  const required = field.required ? ' required' : ''
  const label = `<label for="${id}">${escapeHtml(field.name)}${field.required ? ' *' : ''}
    <span class="muted" style="font-weight:500">${escapeHtml(field.type)}</span></label>`

  switch (field.type) {
    case 'boolean': {
      const current = value === true || value === 1
      return `<div class="field">${label}<select id="${id}" name="${id}">
        <option value="true"${current ? ' selected' : ''}>true</option>
        <option value="false"${current ? '' : ' selected'}>false</option>
      </select></div>`
    }
    case 'json': {
      const text = value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
      return `<div class="field">${label}<textarea class="code" id="${id}" name="${id}" placeholder="null">${escapeHtml(text)}</textarea>
        <span class="hint">Stored as JSON text.</span></div>`
    }
    case 'integer':
      return `<div class="field">${label}<input id="${id}" name="${id}" type="number" step="1"${required} value="${escapeHtml(value ?? '')}"></div>`
    case 'real':
      return `<div class="field">${label}<input id="${id}" name="${id}" type="number" step="any"${required} value="${escapeHtml(value ?? '')}"></div>`
    case 'date':
      return `<div class="field">${label}<input id="${id}" name="${id}" type="text" placeholder="2026-01-01T00:00:00.000Z"${required} value="${escapeHtml(value ?? '')}"></div>`
    case 'text':
      return `<div class="field">${label}<input id="${id}" name="${id}" type="text"${required} value="${escapeHtml(value ?? '')}"></div>`
    case 'file':
      return `<div class="field">${label}<input id="${id}" name="${id}" type="text" placeholder="stored file key" value="${escapeHtml(value ?? '')}">
        <span class="hint">Upload with <code>POST /api/v1/:table/:id/files/${escapeHtml(field.name)}</code>, then paste the returned key here.</span></div>`
  }
}

export function recordPage(
  table: RegisteredTable,
  row: Record<string, unknown> | null,
  csrf: string,
  error?: string,
  user?: AdminUser,
): string {
  const fields = table.config.fields
    .map((field) => formField(field, row?.[field.name] ?? field.default ?? null))
    .join('')

  const action = row
    ? `/admin/tables/${encodeURIComponent(table.name)}/${encodeURIComponent(String(row.id))}`
    : `/admin/tables/${encodeURIComponent(table.name)}`

  const deleteForm = row
    ? `<div class="actions"><form method="post" action="${action}/delete" class="inline"
            data-confirm="Delete this row? This cannot be undone.">
         <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
         <button type="submit" class="btn btn-danger">${icon('trash')}Delete row</button>
       </form></div>`
    : ''

  return renderPage({
    title: row ? `Edit ${table.name}` : `New ${table.name}`,
    user: user ?? null,
    csrf,
    active: 'tables',
    breadcrumbs: [
      { label: 'Data', href: '/admin' },
      { label: table.name, href: `/admin/tables/${encodeURIComponent(table.name)}` },
      { label: row ? 'Edit' : 'New' },
    ],
    body: `${error ? alert('error', escapeHtml(error)) : ''}
    <div class="page-head">
      <div>
        <h1>${row ? 'Edit row' : 'New row'}</h1>
        <p class="sub">${row ? `id <code>${escapeHtml(row.id)}</code>` : `Table <code>${escapeHtml(table.name)}</code> · every rule is checked on save.`}</p>
      </div>
    </div>
    <div class="card">
      <div class="card-body">
        <form method="post" action="${action}">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          ${fields}
          <div class="actions">
            <button type="submit" class="btn btn-primary">${row ? 'Save changes' : 'Create row'}</button>
            <a class="btn" href="/admin/tables/${encodeURIComponent(table.name)}">Cancel</a>
          </div>
        </form>
      </div>
    </div>
    ${
      deleteForm
        ? `<div class="card"><header><h2>Danger zone</h2></header><div class="card-body">
             <p class="hint">Deleting a row cannot be undone. Files attached to it are removed too.</p>
             ${deleteForm}
           </div></div>`
        : ''
    }`,
  })
}

/* Settings ---------------------------------------------------------------- */

export interface SettingsView {
  config: MungilConfig
  configPath?: string
  version: string
  dbFile?: string
  tableCount: number
}

function kv(rows: [string, string][]): string {
  return `<dl class="dl">${rows
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${value}</dd>`)
    .join('')}</dl>`
}

function value(text: string | number | boolean | null | undefined): string {
  if (text === null || text === undefined || text === '') return '<span class="muted">not set</span>'
  if (typeof text === 'boolean') return text ? badge('on', 'ok') : badge('off', 'off')
  return `<code>${escapeHtml(text)}</code>`
}

function yn(on: boolean, onText = 'on', offText = 'off'): string {
  return on ? badge(onText, 'ok') : badge(offText, 'off')
}

export function settingsPage(view: SettingsView, csrf: string, user: AdminUser): string {
  const { config } = view
  const auth = config.auth

  const application = kv([
    ['Version', value(view.version)],
    ['Public URL', value(config.appUrl)],
    ['Listen address', value(`${config.server.host}:${config.server.port}`)],
    ['Database', value(view.dbFile)],
    ['Static files', config.static ? `<code>${escapeHtml(config.static.dir)}</code> ${yn(config.static.spa, 'SPA', 'plain')}` : value(null)],
    ['Allowed origins', config.allowedOrigins.length ? config.allowedOrigins.map((origin) => `<code>${escapeHtml(origin)}</code>`).join(', ') : value(null)],
  ])

  const authentication = auth
    ? kv([
        ['Signup', yn(auth.allowSignup, 'open', 'closed')],
        ['Admin rule bypass', yn(auth.adminBypassRules)],
        ['Access token TTL', value(`${auth.accessTokenTtlSeconds}s`)],
        ['Refresh token TTL', value(`${auth.refreshTokenTtlSeconds}s`)],
        ['Admin session TTL', value(`${auth.adminSessionTtlSeconds}s`)],
        ['Minimum password length', value(auth.minPasswordLength)],
        ['Password reset', yn(auth.passwordReset.enabled)],
      ])
    : `<p class="hint">Authentication is disabled: no <code>auth</code> block is set in the config, so there is no admin panel login.</p>`

  const storage = kv([
    ['Local directory', value(config.storage?.local.dir)],
    ['Tables', value(view.tableCount)],
  ])

  const mcp = config.mcp
    ? kv([
        ['Default user', value(config.mcp.user)],
        ['Exposed tables', config.mcp.tables?.join(', ') || 'all'],
        ['Writes', yn(config.mcp.allowWrite)],
        ['Admin tools', yn(config.mcp.admin)],
        ['Raw SQL', yn(config.mcp.allowRawSql)],
      ])
    : `<p class="hint">No <code>mcp</code> defaults. Run <code>npx mungilbase mcp --print-config</code> to wire up a client.</p>`

  const editing = view.configPath
    ? `<p class="hint">Schema saves rewrite <code>${escapeHtml(view.configPath)}</code> and keep the previous
       version as <code>${escapeHtml(view.configPath)}.bak</code>. Deployments that embed MungilBase through
       <code>createApp()</code> see a read-only editor instead.</p>`
    : alert('warn', 'The schema editor is read-only in this process because no config file path was provided.')

  return renderPage({
    title: 'Settings',
    user,
    csrf,
    active: 'settings',
    body: `<div class="page-head">
      <div>
        <h1>Settings</h1>
        <p class="sub">The effective configuration this process is running with. Edit <code>mungil.config.ts</code> to change it.</p>
      </div>
    </div>
    <div class="card">
      <header><h2>Application</h2></header>
      <div class="card-body">${application}</div>
    </div>
    <div class="card">
      <header><h2>Authentication</h2></header>
      <div class="card-body">${authentication}</div>
    </div>
    <div class="card">
      <header><h2>Data and storage</h2></header>
      <div class="card-body">${storage}</div>
    </div>
    <div class="card">
      <header><h2>AI agents (MCP)</h2></header>
      <div class="card-body">${mcp}</div>
    </div>
    <div class="card">
      <header><h2>Authoring</h2></header>
      <div class="card-body">
        ${kv([
          ['Config file', value(view.configPath)],
          ['Signed in as', value(user.email)],
        ])}
        ${editing}
      </div>
    </div>`,
  })
}

/* Errors ------------------------------------------------------------------ */

export function errorPage(message: string, user?: AdminUser | null): string {
  return renderPage({
    title: 'Error',
    user: user ?? null,
    body: `<div class="page-head"><div><h1>Something went wrong</h1></div></div>
      ${alert('error', escapeHtml(message))}
      <div class="actions"><a class="btn" href="/admin">${icon('arrowLeft')}Back to data</a></div>`,
  })
}

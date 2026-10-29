import type { FieldConfig } from '../config/schema.js'
import type { RegisteredTable } from '../tables/registry.js'

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function layout(title: string, userEmail: string | null, body: string): string {
  const nav = userEmail
    ? `<nav><a href="/admin">Tables</a><span class="who">${escapeHtml(userEmail)}</span></nav>`
    : '<nav>MungilBase</nav>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} · MungilBase</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; }
    header { background: #111; color: #eee; padding: .6rem 1.2rem; display: flex; gap: 1.5rem; align-items: center; }
    header strong { font-size: 1rem; }
    header a { color: #9fd; text-decoration: none; }
    nav { display: flex; gap: 1rem; align-items: center; }
    .who { opacity: .7; font-size: .9rem; }
    main { max-width: 1000px; margin: 1.5rem auto; padding: 0 1rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    code { background: rgba(127,127,127,.15); padding: .1rem .25rem; border-radius: 3px; }
    label { display: block; margin: .8rem 0 .2rem; font-weight: 600; }
    input[type=text], input[type=number], input[type=password], select, textarea { width: 100%; box-sizing: border-box; padding: .45rem; font: inherit; }
    textarea { min-height: 8rem; font-family: ui-monospace, monospace; }
    button { padding: .5rem .9rem; font: inherit; cursor: pointer; }
    .error { background: #fee; color: #900; border: 1px solid #f99; padding: .6rem; margin: 1rem 0; }
    .muted { opacity: .65; }
    .actions { margin-top: 1rem; display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    form.inline { display: inline; }
  </style>
</head>
<body>
  <header><strong>MungilBase</strong>${nav}</header>
  <main>${body}</main>
</body>
</html>`
}

export function loginPage(csrf: string, error?: string): string {
  return layout(
    'Log in',
    null,
    `<h1>Admin login</h1>
     ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
     <form method="post" action="/admin/login">
       <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
       <label for="email">Email</label>
       <input id="email" name="email" type="text" autocomplete="username" required>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <div class="actions"><button type="submit">Log in</button></div>
     </form>
     <p class="muted">Only accounts with the <code>admin</code> role can sign in here.</p>`,
  )
}

function logoutForm(csrf: string): string {
  return `<form method="post" action="/admin/logout" class="inline">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
    <button type="submit">Log out</button>
  </form>`
}

export function dashboardPage(tables: readonly string[], csrf: string, userEmail: string): string {
  const rows = tables
    .map(
      (table) => `<tr>
        <td><a href="/admin/tables/${encodeURIComponent(table)}">${escapeHtml(table)}</a></td>
        <td><a href="/admin/tables/${encodeURIComponent(table)}/new">new</a></td>
      </tr>`,
    )
    .join('')

  return layout(
    'Tables',
    userEmail,
    `<h1>Tables</h1>
     <div class="actions">${logoutForm(csrf)}</div>
     <table><thead><tr><th>Table</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
  )
}

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
  userEmail: string,
  message?: string,
): string {
  const columns = new Set<string>(['id'])
  for (const field of table.config.fields) columns.add(field.name)
  if (table.config.timestamps) {
    columns.add('created_at')
    columns.add('updated_at')
  }

  const header = [...columns].map((column) => `<th>${escapeHtml(column)}</th>`).join('')
  const body = rows
    .map((row) => {
      const cells = [...columns]
        .map((column) => {
          if (column !== 'id') return `<td>${cell(row[column])}</td>`
          const id = String(row.id)
          return `<td><a href="/admin/tables/${encodeURIComponent(table.name)}/${encodeURIComponent(id)}"><code>${escapeHtml(id.slice(0, 8))}…</code></a></td>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')

  const previous =
    page.offset > 0
      ? `<a href="?limit=${page.limit}&offset=${Math.max(0, page.offset - page.limit)}">previous</a>`
      : ''
  const next =
    rows.length === page.limit
      ? `<a href="?limit=${page.limit}&offset=${page.offset + page.limit}">next</a>`
      : ''

  return layout(
    table.name,
    userEmail,
    `${message ? `<div class="error">${escapeHtml(message)}</div>` : ''}
     <h1>${escapeHtml(table.name)}</h1>
     <div class="actions">
       <a href="/admin/tables/${encodeURIComponent(table.name)}/new">New row</a>
       <span class="muted">offset ${page.offset}, limit ${page.limit}</span>
       <span class="muted">${[previous, next].filter(Boolean).join(' · ')}</span>
       ${logoutForm(csrf)}
     </div>
     ${
       rows.length
         ? `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`
         : '<p class="muted">No visible rows (or the list rule hides them).</p>'
     }`,
  )
}

function formField(field: FieldConfig, value: unknown): string {
  const id = `f_${field.name}`
  const required = field.required ? 'required' : ''
  const label = `<label for="${id}">${escapeHtml(field.name)}${field.required ? ' *' : ''} <span class="muted">${escapeHtml(field.type)}</span></label>`

  switch (field.type) {
    case 'boolean': {
      const current = value === true || value === 1
      return `${label}<select id="${id}" name="${id}">
        <option value="true"${current ? ' selected' : ''}>true</option>
        <option value="false"${current ? '' : ' selected'}>false</option>
      </select>`
    }
    case 'json': {
      const text = value === null || value === undefined ? '' : JSON.stringify(value, null, 2)
      return `${label}<textarea id="${id}" name="${id}">${escapeHtml(text)}</textarea>`
    }
    case 'integer':
      return `${label}<input id="${id}" name="${id}" type="number" step="1" ${required} value="${escapeHtml(value ?? '')}">`
    case 'real':
      return `${label}<input id="${id}" name="${id}" type="number" step="any" ${required} value="${escapeHtml(value ?? '')}">`
    case 'date':
      return `${label}<input id="${id}" name="${id}" type="text" placeholder="2026-01-01T00:00:00.000Z" ${required} value="${escapeHtml(value ?? '')}">`
    case 'text':
      return `${label}<input id="${id}" name="${id}" type="text" ${required} value="${escapeHtml(value ?? '')}">`
    case 'file':
      return `${label}<input id="${id}" name="${id}" type="text" placeholder="stored file key" value="${escapeHtml(value ?? '')}">
        <p class="muted">Upload with POST /api/v1/:table/:id/files/${escapeHtml(field.name)}, then paste the returned key here.</p>`
  }
}

export function recordPage(
  table: RegisteredTable,
  row: Record<string, unknown> | null,
  csrf: string,
  error?: string,
): string {
  const fields = table.config.fields
    .map((field) => formField(field, row?.[field.name] ?? field.default ?? null))
    .join('')

  const action = row
    ? `/admin/tables/${encodeURIComponent(table.name)}/${encodeURIComponent(String(row.id))}`
    : `/admin/tables/${encodeURIComponent(table.name)}`

  const deleteForm = row
    ? `<form method="post" action="${action}/delete" class="inline"
            onsubmit="return confirm('Delete this row?')">
         <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
         <button type="submit">Delete</button>
       </form>`
    : ''

  return layout(
    row ? `Edit ${table.name}` : `New ${table.name}`,
    null,
    `${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
     <h1>${row ? 'Edit' : 'New'} ${escapeHtml(table.name)}</h1>
     ${row ? `<p class="muted">id <code>${escapeHtml(row.id)}</code></p>` : ''}
     <form method="post" action="${action}">
       <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
       ${fields}
       <div class="actions">
         <button type="submit">${row ? 'Save' : 'Create'}</button>
         <a href="/admin/tables/${encodeURIComponent(table.name)}">Cancel</a>
         ${deleteForm}
       </div>
     </form>`,
  )
}

export function errorPage(message: string): string {
  return layout(
    'Error',
    null,
    `<h1>Error</h1>
     <div class="error">${escapeHtml(message)}</div>
     <p><a href="/admin">Back to tables</a></p>`,
  )
}

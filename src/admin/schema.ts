import type { FieldType, RulesConfig, TableConfig } from '../config/schema.js'
import type { RegisteredTable } from '../tables/registry.js'
import { OPERATIONS } from '../tables/registry.js'
import { alert, badge, escapeHtml, icon, issuesAlert, renderPage } from './layout.js'

interface AdminUser {
  email: string
  role: string
}

const FIELD_TYPES: FieldType[] = ['text', 'integer', 'real', 'boolean', 'json', 'date', 'file']

const FIELD_TYPE_HINTS: Record<FieldType, string> = {
  text: 'Short or long string. Stored as TEXT.',
  integer: 'Whole number. Stored as INTEGER.',
  real: 'Decimal number. Stored as REAL.',
  boolean: 'true or false. Stored as 0/1 with a CHECK constraint.',
  json: 'Any JSON value. Stored as TEXT, validated with json_valid().',
  date: 'ISO 8601 timestamp string. Stored as TEXT.',
  file: 'Storage key for an uploaded file.',
}

/** A table as the editor renders it, before it has been validated. */
export function blankTable(): TableConfig {
  return {
    name: '',
    fields: [
      { name: '', type: 'text', required: false, unique: false, maxBytes: 5_000_000, allowedTypes: ['image/'] },
    ],
    rules: { list: null, view: null, create: null, update: null, delete: null },
    timestamps: true,
    indexes: [],
  }
}

function defaultText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function ruleText(rule: string | null): string {
  return rule === null ? 'null' : rule
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function referenceOptions(tables: readonly string[], selected: string): string {
  return `<option value="">no reference</option>${tables
    .map((name) => option(name, name, name === selected))
    .join('')}`
}

function fieldRow(field: TableConfig['fields'][number], tables: readonly string[]): string {
  const isFile = field.type === 'file'
  return `<div class="field-row" data-field-row>
    <div class="field-row-main">
      <div class="field">
        <label>Name</label>
        <input name="field_name[]" type="text" value="${escapeHtml(field.name)}" placeholder="title" pattern="[a-z][a-z0-9_]*" title="lowercase letters, digits and underscores">
      </div>
      <div class="field">
        <label>Type</label>
        <select name="field_type[]" data-field-type title="${escapeHtml(FIELD_TYPE_HINTS[field.type])}">
          ${FIELD_TYPES.map((type) => option(type, type, type === field.type)).join('')}
        </select>
      </div>
      <div class="field">
        <label>Required</label>
        <select name="field_required[]">${option('', 'no', !field.required)}${option('1', 'yes', field.required)}</select>
      </div>
      <div class="field">
        <label>Unique</label>
        <select name="field_unique[]">${option('', 'no', !field.unique)}${option('1', 'yes', field.unique)}</select>
      </div>
      <div class="field">
        <label>Default</label>
        <input name="field_default[]" type="text" value="${escapeHtml(defaultText(field.default))}" placeholder="(none)">
      </div>
      <button type="button" class="icon-btn danger" data-remove-field aria-label="Remove field" title="Remove field">${icon('trash')}</button>
    </div>
    <details class="field-adv">
      <summary>Advanced</summary>
      <div class="field-adv-grid">
        <div class="field">
          <label>References table</label>
          <select name="field_ref_table[]">${referenceOptions(tables, field.references?.table ?? '')}</select>
        </div>
        <div class="field">
          <label>References column</label>
          <input name="field_ref_column[]" type="text" value="${escapeHtml(field.references?.column ?? '')}" placeholder="id">
        </div>
        <div class="field" data-for-type="file"${isFile ? '' : ' hidden'}>
          <label>Max bytes</label>
          <input name="field_max_bytes[]" type="number" min="1" value="${escapeHtml(field.maxBytes ?? 5_000_000)}">
        </div>
        <div class="field" data-for-type="file"${isFile ? '' : ' hidden'}>
          <label>Allowed MIME prefixes</label>
          <input name="field_allowed_types[]" type="text" value="${escapeHtml((field.allowedTypes ?? ['image/']).join(', '))}" placeholder="image/, application/pdf">
        </div>
      </div>
    </details>
  </div>`
}

function ruleEditor(operation: keyof RulesConfig, rule: string | null): string {
  const target = `rule_${operation}`
  return `<div class="rule">
    <div class="name">${operation}</div>
    <div>
      <textarea id="${target}" name="${target}" rows="1" class="code" spellcheck="false">${escapeHtml(ruleText(rule))}</textarea>
      <div class="presets">
        <button type="button" class="chip" data-rule-target="${target}" data-rule-set="null">deny</button>
        <button type="button" class="chip" data-rule-target="${target}" data-rule-set="true">public</button>
        <button type="button" class="chip" data-rule-target="${target}" data-rule-set="auth.uid == owner_id">owner only</button>
      </div>
    </div>
  </div>`
}

export interface SchemaFormOptions {
  table: TableConfig
  isNew: boolean
  knownTables: readonly string[]
  csrf: string
  user: AdminUser
  writable: boolean
  configPath?: string
  issues?: string[]
}

export function schemaFormPage(options: SchemaFormOptions): string {
  const { table, isNew, knownTables, user } = options
  const referencesAvailable = [...knownTables].filter((name) => name !== table.name).sort()

  const fields = table.fields.map((field) => fieldRow(field, referencesAvailable)).join('')

  const deleteCard =
    !isNew && options.writable
      ? `<div class="card">
          <header><h2>Remove table</h2></header>
          <div class="card-body">
            <p>Removing <code>${escapeHtml(table.name)}</code> from the config revokes every API route for it
            immediately. The SQLite table and its rows are <strong>not</strong> dropped, so adding the same
            fields back restores access.</p>
            <form method="post" action="/admin/schema/${encodeURIComponent(table.name)}/delete"
                  data-confirm="Remove ${escapeHtml(table.name)} from the config? The API route stops working immediately.">
              <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}">
              <button type="submit" class="btn btn-danger">${icon('trash')}Remove table</button>
            </form>
          </div>
        </div>`
      : ''

  const warning = options.writable
    ? `<p class="hint">Saving validates the table, applies the additive schema change, then rewrites
       <code>${escapeHtml(options.configPath ?? 'the config file')}</code> and keeps a <code>.bak</code> copy.</p>`
    : alert('warn', 'This process has no config file path, so the schema editor is read-only. Set `configPath` when calling `createApp()` if you need editing.')

  return renderPage({
    title: isNew ? 'New table' : `Edit ${table.name}`,
    user,
    csrf: options.csrf,
    active: 'schema',
    wide: true,
    breadcrumbs: [
      { label: 'Schema', href: '/admin/schema' },
      { label: isNew ? 'New table' : table.name },
    ],
    body: `${issuesAlert(options.issues ?? [])}
    <div class="page-head">
      <div>
        <h1>${isNew ? 'New table' : escapeHtml(table.name)}</h1>
        <p class="sub">${isNew ? 'Define fields and the five access rules.' : 'Edit fields and rules. Renaming a table is a migration; do it in the config file.'}</p>
      </div>
      <div class="page-actions">
        <a class="btn" href="/admin/schema">${icon('arrowLeft')}Back</a>
      </div>
    </div>
    <form method="post" action="${isNew ? '/admin/schema' : `/admin/schema/${encodeURIComponent(table.name)}`}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}">
      <div class="card">
        <header><h2>Basics</h2></header>
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" value="${escapeHtml(table.name)}" placeholder="notes"
                     pattern="[a-z][a-z0-9_]*" title="lowercase letters, digits and underscores"
                     ${isNew ? 'required' : 'disabled'} autofocus>
              <span class="hint">${isNew ? 'Lowercase letters, digits and underscores. "auth" is reserved.' : 'Renaming is a migration; edit the config file to rename.'}</span>
            </div>
            <div class="field">
              <label for="timestamps">Timestamps</label>
              <select id="timestamps" name="timestamps">
                ${option('on', 'on — created_at and updated_at', table.timestamps)}
                ${option('off', 'off', !table.timestamps)}
              </select>
              <span class="hint">Maintained by the engine on every write.</span>
            </div>
          </div>
          <div class="field">
            <label for="indexes">Extra indexes</label>
            <textarea id="indexes" name="indexes" rows="2" class="code" spellcheck="false" placeholder="owner_id&#10;done, created_at">${escapeHtml(
              table.indexes.map((entry) => (Array.isArray(entry) ? entry.join(', ') : entry)).join('\n'),
            )}</textarea>
            <span class="hint">One index per line. Use commas for a composite index. File references and <code>created_at</code> are indexed automatically.</span>
          </div>
        </div>
      </div>

      <div class="card">
        <header>
          <h2>Fields</h2>
          <button type="button" class="btn btn-sm" data-add-field>${icon('plus')}Add field</button>
        </header>
        <div class="card-body">
          <div data-field-list>${fields}</div>
          <p class="hint" style="margin-top:.75rem">
            Defaults are typed after the field type: <code>true</code>/<code>false</code> for booleans,
            a number for numeric fields, JSON for <code>json</code>, plain text otherwise. Leave empty for no default
            (the column is nullable).
          </p>
        </div>
      </div>

      <div class="card">
        <header>
          <h2>Rules</h2>
          <span class="badge">deny by default</span>
        </header>
        <div class="card-body">
          <p class="hint" style="margin-bottom:.8rem">
            Each rule is a boolean expression evaluated inside SQLite. <code>null</code> denies everyone,
            <code>true</code> allows everyone, and anything else is an expression such as
            <code>auth.uid == owner_id</code>. Unknown columns are a validation error.
          </p>
          <div class="rules">
            ${OPERATIONS.map((operation) => ruleEditor(operation, table.rules[operation])).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="actions" style="margin:0">
            <button type="submit" class="btn btn-primary"${options.writable ? '' : ' disabled'}>${isNew ? 'Create table' : 'Save changes'}</button>
            <a class="btn" href="/admin/schema">Cancel</a>
            ${warning}
          </div>
        </div>
      </div>
    </form>
    ${deleteCard}

    <template id="field-row-template">
      ${fieldRow(blankTable().fields[0]!, referencesAvailable)}
    </template>`,
  })
}

/* Schema overview --------------------------------------------------------- */

function ruleSummary(table: RegisteredTable): string {
  const open = OPERATIONS.filter((operation) => table.rules[operation] === 'true').length
  const conditional = OPERATIONS.filter((operation) => {
    const rule = table.rules[operation]
    return rule !== null && rule !== 'true'
  }).length
  const denied = OPERATIONS.length - open - conditional
  const parts: string[] = []
  if (open) parts.push(badge(`${open} public`, 'ok'))
  if (conditional) parts.push(badge(`${conditional} conditional`, 'accent'))
  if (denied) parts.push(badge(`${denied} denied`, 'off'))
  return parts.join('')
}

export function schemaPage(
  tables: readonly RegisteredTable[],
  csrf: string,
  user: AdminUser,
  options: { writable: boolean; configPath?: string; message?: string },
): string {
  const rows = tables
    .map(
      (table) => `<tr>
        <td>
          <a href="/admin/schema/${encodeURIComponent(table.name)}"><strong>${escapeHtml(table.name)}</strong></a>
          <div class="muted small">${escapeHtml(table.config.fields.map((field) => field.name).join(', ')) || '<span class="muted">no fields</span>'}</div>
        </td>
        <td class="nowrap">${badge(`${table.config.fields.length} field${table.config.fields.length === 1 ? '' : 's'}`)}${table.config.timestamps ? badge('timestamps') : ''}</td>
        <td class="nowrap">${ruleSummary(table)}</td>
        <td class="actions-cell">
          <a class="btn btn-sm" href="/admin/schema/${encodeURIComponent(table.name)}">${icon('edit')}Edit</a>
          <a class="btn btn-sm btn-ghost" href="/admin/tables/${encodeURIComponent(table.name)}">Rows</a>
        </td>
      </tr>`,
    )
    .join('')

  const empty = `<div class="card card-body empty">
      ${icon('sliders')}
      <h3>No tables defined</h3>
      <p>Create a table to get REST routes for it. Nothing is exposed until a rule allows it.</p>
      <a class="btn btn-primary" href="/admin/schema/new">${icon('plus')}New table</a>
    </div>`

  return renderPage({
    title: 'Schema',
    user,
    csrf,
    active: 'schema',
    wide: true,
    body: `${options.message ? `<div data-flash>${alert('ok', escapeHtml(options.message))}</div>` : ''}
    <div class="page-head">
      <div>
        <h1>Schema</h1>
        <p class="sub">Tables, fields and access rules. Saving writes the config file and applies the change live.</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-primary" href="/admin/schema/new">${icon('plus')}New table</a>
      </div>
    </div>
    ${
      options.writable
        ? `<div class="alert alert-info">
            Changes are written to <code>${escapeHtml(options.configPath ?? 'the config file')}</code> with a
            <code>.bak</code> copy of the previous version. Anything in that file that is not plain data
            (functions, <code>process.env</code> lookups) is replaced by its current value.
          </div>`
        : alert('warn', 'No config file path is known to this process, so the schema editor is read-only.')
    }
    ${
      tables.length
        ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Table</th><th>Shape</th><th>Rules</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`
        : empty
    }`,
  })
}

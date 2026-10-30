import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_CANDIDATES } from '../config/load.js'
import { loadConfig } from '../config/load.js'
import { authConfigSchema } from '../config/schema.js'
import { openDatabase } from '../db/connect.js'
import { applyMigrations } from '../db/migrator.js'
import { migrations } from '../db/migrations.js'
import { ensureSchema } from '../db/ddl.js'
import { createRegistry } from '../tables/registry.js'
import { ensureAuthSchema } from '../auth/schema.js'
import { ensureAuditSchema } from '../audit/log.js'
import { AuthService } from '../auth/service.js'
import { createRow } from '../tables/crud.js'

export interface InitOptions {
  directory?: string
  force?: boolean
  /** Write `mungil.config.json` instead of a TypeScript config. */
  json?: boolean
  /**
   * Scaffold the working todo example: migrate, seed a few rows and create a
   * demo account whose generated password is printed once.
   */
  demo?: boolean
  /** Email of the demo account. Defaults to `demo@example.com`. */
  demoEmail?: string
}

export interface InitResult {
  directory: string
  created: string[]
  skipped: string[]
  demo?: {
    email: string
    password: string
    database: string
    todos: number
  }
}

const STATIC_BLOCK_TS = `  // Serve ./public from this process: one command, one port, one origin.
  static: { dir: './public', spa: true },`

const STATIC_BLOCK_JSON = `  "static": { "dir": "./public", "spa": true },`

const TYPESCRIPT_CONFIG = `/**
 * MungilBase config. It is validated at boot, so a typo is a startup error
 * rather than a runtime surprise.
 *
 * Docs: https://github.com/izulwahidin/mungilbase#config
 *
 * Tip: run \`npm install --save-dev mungilbase\` in this project to get editor
 * autocomplete from \`import type { MungilConfigInput } from 'mungilbase/config'\`.
 */
export default {
  appUrl: 'http://localhost:8787',
  server: { host: '0.0.0.0', port: 8787 },
${STATIC_BLOCK_TS}
  database: { file: './data/mungil.db' },
  storage: { local: { dir: './data/files' } },
  auth: {
    // Signup is closed by default in production; open it while you build.
    allowSignup: true,
  },
  // Defaults for \`mungilbase mcp\`, so a client config can stay short.
  // mcp: { user: 'you@example.com', allowWrite: true },
  tables: [
    {
      name: 'notes',
      fields: [
        // An \`auth.uid\` value, not a foreign key: auth users live in _mungil_* tables.
        { name: 'owner_id', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
      ],
      // Every operation must be explicit. null = deny, 'true' = allow.
      rules: {
        list: 'published == true | auth.uid == owner_id',
        view: 'published == true | auth.uid == owner_id',
        create: 'auth.uid != null & owner_id == auth.uid',
        update: 'auth.uid == owner_id',
        delete: 'auth.uid == owner_id',
      },
      indexes: ['owner_id', 'published'],
    },
  ],
}
`

const JSON_CONFIG = `{
  "appUrl": "http://localhost:8787",
  "server": { "host": "0.0.0.0", "port": 8787 },
${STATIC_BLOCK_JSON}
  "database": { "file": "./data/mungil.db" },
  "storage": { "local": { "dir": "./data/files" } },
  "auth": { "allowSignup": true },
  "tables": [
    {
      "name": "notes",
      "fields": [
        { "name": "owner_id", "type": "text", "required": true },
        { "name": "title", "type": "text", "required": true },
        { "name": "body", "type": "text" },
        { "name": "published", "type": "boolean", "default": false }
      ],
      "rules": {
        "list": "published == true | auth.uid == owner_id",
        "view": "published == true | auth.uid == owner_id",
        "create": "auth.uid != null & owner_id == auth.uid",
        "update": "auth.uid == owner_id",
        "delete": "auth.uid == owner_id"
      },
      "indexes": ["owner_id", "published"]
    }
  ]
}
`

const DEMO_TYPESCRIPT_CONFIG = `/**
 * MungilBase todo example. One process serves the API and the frontend.
 *
 * Docs: https://github.com/izulwahidin/mungilbase#config
 */
export default {
  appUrl: 'http://localhost:8787',
  server: { host: '0.0.0.0', port: 8787 },
  // Serve ./public from this process: one command, one port, one origin.
  static: { dir: './public', spa: true },
  database: { file: './data/mungil.db' },
  storage: { local: { dir: './data/files' } },
  auth: { allowSignup: true },
  // Defaults for \`mungilbase mcp\`; replace the email with your own account.
  mcp: { user: 'demo@example.com', tables: ['todos'], allowWrite: true },
  tables: [
    {
      name: 'todos',
      fields: [
        { name: 'owner_id', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'done', type: 'boolean', default: false },
      ],
      rules: {
        list: 'auth.uid == owner_id',
        view: 'auth.uid == owner_id',
        create: 'auth.uid != null & owner_id == auth.uid',
        update: 'auth.uid == owner_id',
        delete: 'auth.uid == owner_id',
      },
      indexes: ['owner_id', 'done'],
    },
  ],
}
`

const DEMO_JSON_CONFIG = `{
  "appUrl": "http://localhost:8787",
  "server": { "host": "0.0.0.0", "port": 8787 },
  "static": { "dir": "./public", "spa": true },
  "database": { "file": "./data/mungil.db" },
  "storage": { "local": { "dir": "./data/files" } },
  "auth": { "allowSignup": true },
  "mcp": { "user": "demo@example.com", "tables": ["todos"], "allowWrite": true },
  "tables": [
    {
      "name": "todos",
      "fields": [
        { "name": "owner_id", "type": "text", "required": true },
        { "name": "title", "type": "text", "required": true },
        { "name": "done", "type": "boolean", "default": false }
      ],
      "rules": {
        "list": "auth.uid == owner_id",
        "view": "auth.uid == owner_id",
        "create": "auth.uid != null & owner_id == auth.uid",
        "update": "auth.uid == owner_id",
        "delete": "auth.uid == owner_id"
      },
      "indexes": ["owner_id", "done"]
    }
  ]
}
`

const ENV_EXAMPLE = `# Optional overrides. The defaults in mungil.config.ts work for local use.
#
# The CLI loads this file when it is named \`.env\` (real environment variables
# win). Copy it: cp .env.example .env
MUNGIL_CONFIG=./mungil.config.ts
MUNGIL_DB_FILE=./data/mungil.db
MUNGIL_VERSION=

# Set to 1 only when a trusted reverse proxy sets X-Forwarded-For.
MUNGIL_TRUST_PROXY=

# Require a bearer token on GET /metrics.
MUNGIL_METRICS_TOKEN=

# Optional Sentry-compatible DSN.
MUNGIL_SENTRY_DSN=

# Used once by \`mungilbase user create|passwd\`.
# Prefer --password-stdin or --generate-password so it never lands in shell history.
MUNGIL_USER_PASSWORD=
MUNGIL_USER_ROLE=user

# SMTP password (see email.smtp.passwordEnv).
MUNGIL_SMTP_PASSWORD=
`

const GITIGNORE = `node_modules/
data/
backups/
*.db
*.db-wal
*.db-shm

# Secrets
.env
.env.*
!.env.example
`

const STARTER_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MungilBase</title>
    <style>
      :root { color-scheme: light dark; --fg: #1c1c1a; --muted: #6d6d67; --line: #e2e2dc; }
      @media (prefers-color-scheme: dark) { :root { --fg: #ececeb; --muted: #9a9a95; --line: #2e2e35; } }
      body { margin: 0; padding: 64px 20px; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: Canvas; }
      main { max-width: 560px; margin: 0 auto; }
      h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: -0.02em; }
      p { margin: 0 0 20px; color: var(--muted); }
      ul { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
      li { padding: 10px 0; border-bottom: 1px solid var(--line); }
      a { color: inherit; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
      .ok { color: #2f6f4f; }
      .down { color: #b3362b; }
    </style>
  </head>
  <body>
    <main>
      <h1>MungilBase</h1>
      <p id="status">Checking the API…</p>
      <ul>
        <li><a href="/api/v1/openapi.json">OpenAPI 3.1 document</a></li>
        <li><a href="/health">Health</a> · <a href="/metrics">Metrics</a></li>
        <li><a href="/admin">Admin panel</a> (needs an admin account)</li>
      </ul>
      <p style="margin-top: 20px">
        Edit <code>public/index.html</code> to build your frontend, or
        <code>tables</code> in the config to change the API. Then run
        <code>npx mungilbase migrate</code>.
      </p>
    </main>
    <script>
      fetch('/health')
        .then(function (response) { return response.json() })
        .then(function (body) {
          document.getElementById('status').innerHTML =
            '<span class="ok">API is up</span> — v' + body.version +
            ', ' + body.uptimeSeconds + 's uptime.'
        })
        .catch(function () {
          document.getElementById('status').innerHTML =
            '<span class="down">API is not reachable.</span> Is the server running?'
        })
    </script>
  </body>
</html>
`

const DEMO_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Todos</title>
    <style>
      :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1c1c1a; --muted: #6d6d67; --card: #fff; --line: #e2e2dc; --accent: #2f6f4f; --accent-fg: #fff; --danger: #b3362b; }
      @media (prefers-color-scheme: dark) { :root { --bg: #16161a; --fg: #ececeb; --muted: #9a9a95; --card: #1e1e23; --line: #2e2e35; --accent: #56a37c; --accent-fg: #0d1b12; --danger: #e2705f; } }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 48px 16px 96px; background: var(--bg); color: var(--fg); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      main { width: 100%; max-width: 560px; margin: 0 auto; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
      h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -0.02em; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
      label { display: block; margin-bottom: 14px; font-size: 14px; color: var(--muted); }
      input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px; font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 8px; }
      button { font: inherit; cursor: pointer; }
      .primary { width: 100%; padding: 10px 16px; font-weight: 600; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 8px; }
      .link { padding: 0; font-size: 14px; color: var(--muted); background: none; border: 0; text-decoration: underline; text-underline-offset: 3px; }
      .add { display: flex; gap: 10px; padding: 12px; }
      .add input { margin: 0; border: 0; }
      .add .primary { width: auto; flex: none; padding: 10px 18px; }
      ul { margin: 20px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
      li { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--line); }
      li input[type="checkbox"] { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
      .title { flex: 1; padding: 0; text-align: left; color: inherit; background: none; border: 0; overflow-wrap: anywhere; }
      .remove { flex: none; padding: 4px 8px; font-size: 13px; color: var(--muted); background: none; border: 0; border-radius: 6px; }
      .remove:hover { color: var(--danger); }
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 20px; font-size: 14px; color: var(--muted); }
      .count { margin-right: auto; }
      .filters { display: flex; gap: 4px; }
      .chip { padding: 4px 10px; font-size: 13px; color: var(--muted); background: none; border: 1px solid transparent; border-radius: 999px; }
      .chip.active { color: var(--fg); border-color: var(--line); }
      .error { margin: 12px 0 0; font-size: 14px; color: var(--danger); }
      .error:empty { display: none; }
      .hint { margin: 18px 0 0; font-size: 13px; color: var(--muted); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>todos</h1>
        <div id="account" hidden style="display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--muted)">
          <span id="whoami"></span>
          <button type="button" id="logout" class="link">Sign out</button>
        </div>
      </header>

      <section id="auth" class="card" hidden>
        <h2 id="auth-title" style="margin: 0 0 16px; font-size: 18px">Sign in</h2>
        <form id="auth-form">
          <label>Email<input id="email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>
          <label>Password<input id="password" type="password" autocomplete="current-password" required minlength="8" /></label>
          <button type="submit" id="auth-submit" class="primary">Sign in</button>
          <button type="button" id="auth-switch" class="link" style="display: block; margin: 14px auto 0">Need an account? Register</button>
          <p class="error" id="auth-error" role="alert"></p>
        </form>
      </section>

      <section id="board" hidden>
        <form id="add-form" class="add card">
          <input id="new-title" placeholder="What needs doing?" autocomplete="off" maxlength="200" required />
          <button type="submit" class="primary">Add</button>
        </form>
        <ul id="todos"></ul>
        <p id="empty" class="hint" hidden>Nothing here yet.</p>
        <div class="bar">
          <span id="count" class="count"></span>
          <div class="filters">
            <button type="button" data-filter="all" class="chip active">All</button>
            <button type="button" data-filter="active" class="chip">Active</button>
            <button type="button" data-filter="done" class="chip">Done</button>
          </div>
        </div>
      </section>

      <p class="error" id="board-error" role="alert"></p>
    </main>

    <script>
      var API = '/api/v1'
      var KEY = 'mungil.session'
      var state = { mode: 'login', session: null, todos: [], filter: 'all' }
      function byId(id) { return document.getElementById(id) }

      function save(session) {
        state.session = session
        if (session) localStorage.setItem(KEY, JSON.stringify(session))
        else localStorage.removeItem(KEY)
      }

      function load() {
        try {
          var value = JSON.parse(localStorage.getItem(KEY) || 'null')
          if (value && value.tokens && value.tokens.accessToken) return value
        } catch (error) {}
        return null
      }

      function refresh() {
        if (!state.session || !state.session.tokens) return Promise.resolve(false)
        return fetch(API + '/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: state.session.tokens.refreshToken })
        })
          .then(function (response) { return response.ok ? response.json() : false })
          .then(function (session) { if (session) save(session); return Boolean(session) })
      }

      function api(path, options) {
        options = options || {}
        var headers = {}
        if (options.body !== undefined) headers['content-type'] = 'application/json'
        if (state.session) headers.authorization = 'Bearer ' + state.session.tokens.accessToken
        return fetch(API + path, {
          method: options.method || 'GET',
          headers: headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        }).then(function (response) {
          if (response.status === 401 && !options.retried) {
            return refresh().then(function (ok) {
              if (!ok) throw new Error('Session expired. Sign in again.')
              return api(path, { method: options.method, body: options.body, retried: true })
            })
          }
          return response.text().then(function (text) {
            var data = text ? JSON.parse(text) : null
            if (!response.ok) {
              throw new Error((data && data.error && data.error.message) || response.statusText)
            }
            return data
          })
        })
      }

      function showAuth() {
        byId('account').hidden = true
        byId('auth').hidden = false
        byId('board').hidden = true
        byId('email').focus()
      }

      function showBoard() {
        byId('account').hidden = false
        byId('whoami').textContent = state.session.user.email
        byId('auth').hidden = true
        byId('board').hidden = false
      }

      function setMode(mode) {
        state.mode = mode
        var registering = mode === 'register'
        byId('auth-title').textContent = registering ? 'Create account' : 'Sign in'
        byId('auth-submit').textContent = registering ? 'Register' : 'Sign in'
        byId('auth-switch').textContent = registering ? 'Have an account? Sign in' : 'Need an account? Register'
        byId('password').autocomplete = registering ? 'new-password' : 'current-password'
        byId('auth-error').textContent = ''
      }

      function render() {
        var items = state.todos.filter(function (todo) {
          if (state.filter === 'active') return !todo.done
          if (state.filter === 'done') return todo.done
          return true
        })
        var list = byId('todos')
        list.textContent = ''

        items.forEach(function (todo) {
          var li = document.createElement('li')
          var checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.checked = Boolean(todo.done)
          checkbox.setAttribute('data-id', todo.id)
          var title = document.createElement('button')
          title.type = 'button'
          title.className = 'title'
          title.setAttribute('data-id', todo.id)
          title.textContent = todo.title
          var remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'remove'
          remove.setAttribute('data-remove', todo.id)
          remove.textContent = 'Delete'
          li.appendChild(checkbox)
          li.appendChild(title)
          li.appendChild(remove)
          list.appendChild(li)
        })

        var remaining = state.todos.filter(function (todo) { return !todo.done }).length
        byId('count').textContent = remaining + ' of ' + state.todos.length + ' left'
        byId('empty').hidden = items.length > 0
        byId('empty').textContent = state.todos.length ? 'No todos match this filter.' : 'Nothing here yet.'
        Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
          chip.classList.toggle('active', chip.getAttribute('data-filter') === state.filter)
        })
      }

      function loadTodos() {
        return api('/todos?sort=-created_at&limit=200').then(function (data) {
          state.todos = data.items
          render()
        })
      }

      function toggle(id) {
        var todo = state.todos.find(function (item) { return item.id === id })
        if (!todo) return
        api('/todos/' + id, { method: 'PATCH', body: { done: !todo.done } })
          .then(function (updated) { Object.assign(todo, updated); render() })
          .catch(report)
      }

      function remove(id) {
        api('/todos/' + id, { method: 'DELETE' })
          .then(function () {
            state.todos = state.todos.filter(function (item) { return item.id !== id })
            render()
          })
          .catch(report)
      }

      function report(error) { byId('board-error').textContent = error.message }

      byId('auth-switch').addEventListener('click', function () {
        setMode(state.mode === 'login' ? 'register' : 'login')
      })

      byId('auth-form').addEventListener('submit', function (event) {
        event.preventDefault()
        byId('auth-error').textContent = ''
        byId('auth-submit').disabled = true
        var body = { email: byId('email').value.trim(), password: byId('password').value }
        api(state.mode === 'register' ? '/auth/register' : '/auth/login', { method: 'POST', body: body })
          .then(function (session) {
            save(session)
            byId('password').value = ''
            showBoard()
            return loadTodos()
          })
          .catch(function (error) { byId('auth-error').textContent = error.message })
          .then(function () { byId('auth-submit').disabled = false })
      })

      byId('logout').addEventListener('click', function () {
        api('/auth/logout', { method: 'POST' })
          .catch(function () {})
          .then(function () {
            save(null)
            state.todos = []
            render()
            showAuth()
          })
      })

      byId('add-form').addEventListener('submit', function (event) {
        event.preventDefault()
        var input = byId('new-title')
        var title = input.value.trim()
        if (!title) return
        api('/todos', { method: 'POST', body: { owner_id: state.session.user.id, title: title } })
          .then(function (todo) { state.todos.unshift(todo); input.value = ''; render() })
          .catch(report)
        input.focus()
      })

      byId('todos').addEventListener('change', function (event) {
        if (event.target.type === 'checkbox') toggle(event.target.getAttribute('data-id'))
      })

      byId('todos').addEventListener('click', function (event) {
        var removeId = event.target.getAttribute('data-remove')
        if (removeId) return remove(removeId)
        if (event.target.classList.contains('title')) toggle(event.target.getAttribute('data-id'))
      })

      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
        chip.addEventListener('click', function () {
          state.filter = chip.getAttribute('data-filter')
          render()
        })
      })

      var existing = load()
      if (!existing) {
        setMode('login')
        showAuth()
      } else {
        state.session = existing
        api('/auth/me')
          .then(function (user) { save({ user: user, tokens: state.session.tokens }); showBoard(); return loadTodos() })
          .catch(function () { save(null); setMode('login'); showAuth() })
      }
    </script>
  </body>
</html>
`

/**
 * Scaffolds a project that `npx mungilbase start` can run immediately.
 * Existing files are left alone unless `force` is set.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const directory = resolve(options.directory ?? '.')
  const configName = options.json ? 'mungil.config.json' : 'mungil.config.ts'

  const existingConfigs = CONFIG_CANDIDATES.map((name) => join(directory, name)).filter((path) =>
    existsSync(path),
  )
  if (existingConfigs.length && !options.force) {
    throw new Error(
      `${existingConfigs[0]} already exists. Pass --force to overwrite it, or run init in an empty directory.`,
    )
  }

  await mkdir(directory, { recursive: true })

  const demo = options.demo ?? false
  const configContents = options.json
    ? demo
      ? DEMO_JSON_CONFIG
      : JSON_CONFIG
    : demo
      ? DEMO_TYPESCRIPT_CONFIG
      : TYPESCRIPT_CONFIG

  const files: Array<{ name: string; contents: string }> = [
    { name: configName, contents: configContents },
    { name: '.env.example', contents: ENV_EXAMPLE },
    { name: '.gitignore', contents: GITIGNORE },
    { name: 'public/index.html', contents: demo ? DEMO_INDEX_HTML : STARTER_INDEX_HTML },
  ]

  const created: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    const path = join(directory, file.name)
    if (existsSync(path) && !options.force) {
      skipped.push(path)
      continue
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents, 'utf8')
    created.push(path)
  }

  const result: InitResult = { directory, created, skipped }

  if (demo) {
    result.demo = await seedDemo(directory, configName, options.demoEmail ?? 'demo@example.com')
  }

  return result
}

/**
 * Migrates the scaffolded database, creates the demo account and inserts a few
 * todos through the same ruled CRUD path the API uses.
 */
async function seedDemo(
  directory: string,
  configName: string,
  email: string,
): Promise<NonNullable<InitResult['demo']>> {
  const config = await loadConfig(join(directory, configName))
  const dbFile = config.database.file
  const database = dbFile === ':memory:' ? dbFile : resolve(directory, dbFile)
  const db = openDatabase(database)

  try {
    applyMigrations(db, migrations)
    const registry = createRegistry(config)
    ensureSchema(db, registry)
    ensureAuthSchema(db)
    ensureAuditSchema(db)

    const service = new AuthService(db, config.auth ?? authConfigSchema.parse({}))
    const password = randomPassword()
    const user = await service.createUser({ email, password }, 'user')

    const table = registry.get('todos')
    if (!table) throw new Error('The demo config must declare a "todos" table')
    const auth = { uid: user.id, role: user.role, admin: false }
    const seeds = ['Try the todo API', 'Connect the MCP server to your agent', 'Read docs/getting-started.md']
    seeds.forEach((title, index) => {
      createRow(db, table, auth, { owner_id: user.id, title, done: index === 0 })
    })

    return { email, password, database, todos: seeds.length }
  } finally {
    db.close()
  }
}

function randomPassword(): string {
  // 18 random bytes -> 24 url-safe characters. Printed once, never stored.
  return randomBytes(18).toString('base64url')
}

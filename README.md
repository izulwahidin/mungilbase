# MungilBase

**mungil** *(Indonesian)* — tiny, small.

A small, self-hosted backend defined by one typed config file: REST endpoints,
authentication, row-level rules, migrations, and an MCP server for AI agents.
Ships as an npm package and a typed library; runs as a single Node process with
SQLite.

> **Status: v0.6.0 (pre-1.0).** Feature-complete for a single-node self-hosted
> deployment, but it has not been through an external security audit or a
> production load test. Read [What works today](#what-works-today) and the
> [production gate](#production-gate) before relying on it.

## Why

Existing "config as backend" tools are excellent, but each asks for a trade:
a hosted platform, a VPS and an admin UI, or a serverless database with
transactional gaps. MungilBase is deliberately the boring option:

- **One process, one file.** Node + SQLite in WAL mode. Your data is a file you
  can copy, and `npx mungilbase start` is the whole deploy.
- **Real transactions.** Sessions, rule-checked writes, and migrations run
  inside SQLite transactions, not eventually-consistent stores.
- **Rules are SQL.** Access rules compile to parameterized `WHERE` clauses and
  execute inside the database, so unauthorized rows never leave it.
- **Deny by default.** Every table must declare all five rules; `null` is
  deny, `'true'` is allow, and there is no implicit "open" state.
- **Agents get the same rules.** The optional MCP server reuses the HTTP CRUD
  functions, so an AI agent cannot bypass a rule by taking a different path.

## Install

Requires Node.js 22 or newer.

```bash
# or pin it: npm install --save-dev mungilbase
npx mungilbase init      # mungil.config.ts, public/, .env.example, .gitignore
npx mungilbase migrate   # apply migrations + additively sync the schema
npx mungilbase start
curl localhost:8787/health
```

Open <http://localhost:8787> — `init` enables `static: { dir: './public' }`, so
the same process serves the frontend and the API. Edit `public/index.html` for
your UI, or `tables` in the config for your API.

Then open <http://localhost:8787/admin>: a fresh deployment has no
administrator, so the panel asks you to create the first one in the browser.
No CLI command, no seed script.

Want a working app in one command? `init --demo` scaffolds a todo list,
migrates, seeds three rows and creates an account with a generated password:

```bash
npx mungilbase init --demo
npx mungilbase start
# Demo password is printed once by init.
```

`init` creates a starter config with a `notes` table and signup enabled, so you
can try the API immediately. Edit the config, then run `migrate` again.

The repository's example config (`mungil.config.ts`) describes `posts`; the
one from `init` describes `notes`. Either is validated at boot, so a typo is a
startup error, not a runtime surprise.

Everything the CLI can do:

```bash
npx mungilbase --help
npx mungilbase doctor                 # validate config + every rule
npx mungilbase dev                    # restart + regenerate when the config changes
npx mungilbase gen                    # openapi.json + typed SDK
npx mungilbase gen --check            # fail when generated files are stale
npx mungilbase openapi ./openapi.json
npx mungilbase sdk ./sdk/client.ts
npx mungilbase backup ./backups
npx mungilbase files gc               # dry run; --apply deletes
npx mungilbase mcp --check            # exercise the MCP server
npx mungilbase mcp --print-config opencode
```

The CLI loads `./.env` when it exists (real environment variables win). Pass
`--env-file <path>` to use another file.

See [docs/cli.md](docs/cli.md) for the full command reference and
[docs/getting-started.md](docs/getting-started.md) for a guided first project.

### Use as a library

```ts
import { loadConfig, startServer, generateSdk, openMcpContext } from 'mungilbase'
import type { MungilConfigInput } from 'mungilbase/config'
```

The package exports the config schema and loader, server boot, OpenAPI builder,
SDK generator, and MCP server. Importing `mungilbase` never opens a database or
starts a listener. See
[Using it as a library](docs/cli.md#using-it-as-a-library).

### From source

```bash
npm install
npm run dev
curl localhost:8787/health
curl localhost:8787/version
```

Apply migrations and sync the schema:

```bash
npm run migrate   # checksummed migrations + additive schema sync
```

Create an account (signup is closed by default), and reset one if someone is
locked out (this also revokes all of their sessions):

```bash
MUNGIL_USER_PASSWORD='correct horse battery' npm run user:create -- me@example.com
MUNGIL_USER_PASSWORD='a different long password' npm run user:passwd -- me@example.com
```

Back up, prove the backup works, and take a load baseline:

```bash
npm run backup -- ./backups
npm run drill                    # online backup -> verify -> restore -> compare
npm run bench -- --concurrency 16 --seconds 10

# Larger load test (needs k6)
npx tsx scripts/seed.ts --config ./mungil.config.json --table posts --rows 100000
k6 run scripts/loadtest.k6.js
```

Run everything CI runs, locally, in one command:

```bash
npm run ci                      # typecheck, tests, build, restore drill
git config core.hooksPath .githooks   # optional: enforce it before every push
```

Log in and use the token (examples assume `jq`):

```bash
TOKEN=$(curl -s localhost:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery"}' | jq -r .tokens.accessToken)

USER_ID=$(curl -s localhost:8787/api/v1/auth/me -H "Authorization: Bearer $TOKEN" | jq -r .id)

curl -X POST localhost:8787/api/v1/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"owner_id\":\"$USER_ID\",\"title\":\"Hello\"}"
```

### Endpoints

| Method | Path | Rule applied |
|---|---|---|
| `GET` | `/api/v1/:table` | `list` |
| `GET` | `/api/v1/:table/:id` | `view` |
| `POST` | `/api/v1/:table` | `create` (201) |
| `PATCH` | `/api/v1/:table/:id` | `update` |
| `DELETE` | `/api/v1/:table/:id` | `delete` |

### Auth endpoints

Registered only when the config has an `auth` block.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/auth/register` | `201` + tokens; `403` unless `allowSignup` |
| `POST` | `/api/v1/auth/login` | `200` + tokens; uniform `401`; `429` when throttled |
| `POST` | `/api/v1/auth/refresh` | rotates access **and** refresh tokens |
| `POST` | `/api/v1/auth/request-password-reset` | `202` always; needs `email` config |
| `POST` | `/api/v1/auth/reset-password` | consumes a single-use token, revokes sessions |
| `POST` | `/api/v1/auth/verify-email` | consumes a single-use verification token |
| `POST` | `/api/v1/auth/resend-verification` | authenticated, throttled; needs `emailVerification` |
| `POST` | `/api/v1/auth/logout` | `204`, revokes the session |
| `GET` | `/api/v1/auth/me` | current user; `401` without a token |

### OAuth

Google and GitHub are supported when configured:

```ts
auth: {
  oauth: {
    google: { clientId: '…' },   // secret: MUNGIL_GOOGLE_CLIENT_SECRET
    github: { clientId: '…' },   // secret: MUNGIL_GITHUB_CLIENT_SECRET
  },
}
```

| Method | Path |
|---|---|
| `GET` | `/api/v1/auth/oauth/:provider/start` |
| `GET` | `/api/v1/auth/oauth/:provider/callback` |

The callback redirects to `${appUrl}/auth/callback` with tokens in the URL
**fragment** (`#access_token=…&refresh_token=…`), which is never sent to a
server or in a Referer header. Accounts are linked by provider-verified email;
an unverified provider email is rejected. Register the callback URL
`${appUrl}/api/v1/auth/oauth/{google|github}/callback` in the provider console.

Sessions are opaque 256-bit tokens stored as SHA-256 hashes in SQLite, not
JWTs. That makes logout and revocation immediate instead of "eventually, when
the token expires". Refresh tokens are single-use: replaying a rotated token
revokes the entire session family.

### Files

A `file` field stores a storage key. Two routes handle it:

| Method | Path | Rule applied |
|---|---|---|
| `POST` | `/api/v1/:table/:id/files/:field` | `update`, multipart field `file` |
| `GET` | `/api/v1/:table/:id/files/:field` | `view` |

Uploads are limited by the field's `maxBytes` (5 MB default) and
`allowedTypes` MIME prefixes (`['image/']` default). The file is written before
the row update; if the update rule denies, the file is deleted again. Replacing
a file deletes the old object, and deleting a row deletes the files it
referenced.

Storage is local disk by default (`storage.local.dir`, `./data/files`).
S3-compatible backends work too:

```ts
storage: {
  provider: 's3',
  s3: {
    bucket: 'mungil-files',
    region: 'auto',
    endpoint: 'https://minio.example.com', // omit for AWS
    prefix: 'mungil',
    // credentials read from MUNGIL_S3_ACCESS_KEY_ID / MUNGIL_S3_SECRET_ACCESS_KEY
  },
}
```

The bucket needs Put/Get/Delete/List on the configured prefix. Files are not
part of the SQLite backup; use bucket versioning or replicate them separately.

Objects can still be orphaned by a crash between the row write and the delete.
Collect them with:

```bash
npx mungilbase files gc              # dry run
npx mungilbase files gc --apply      # delete unreferenced objects
npm run files:gc -- --apply          # from a source checkout
```

Auth users live in internal `_mungil_*` tables. They are not config tables, so
a `user_id` column in your schema is a plain text reference to `auth.uid`, not
a foreign key.

Password reset is enabled only when `email` is configured and `appUrl` or
`auth.passwordReset.resetUrl` is set. `email.provider` is `log` (development
only; refuses to start under `NODE_ENV=production`) or `smtp`. Tokens are
hashed at rest, single-use, 30 minutes by default, and a reset revokes every
session for the account.

Email verification is off by default. Set `auth.emailVerification.enabled` to
send a link on registration, and `required: true` to reject logins until the
address is verified. Resending needs a session and is throttled. Accounts
created with `mungilbase user create` start verified, since the operator
vouched for them.

Users have a closed role: `user` or `admin`. Promotion alone does **not**
bypass table rules; set `auth.adminBypassRules: true` if admins should see and
write everything. Roles are read from the database on every request, so a
change applies to already-issued tokens immediately.

```bash
npx mungilbase user role me@example.com admin
```

### Admin panel

A PocketBase-style console at `/admin`: sidebar navigation, light/dark theme,
data browser, schema editor and a read-only view of the effective config. It is
server-rendered with a small hand-written stylesheet and a ~150-line script, so
there is still no build step and no frontend dependency.

**First run.** While the deployment has no `admin` account, `/admin/setup`
creates the first administrator from the browser. As soon as one exists the
page closes and only the login form remains; it reopens only if every admin is
deleted again (accounts can only be removed by an operator). Treat a fresh
instance like any other install wizard: deploy it on a trusted network or claim
it right after `start`.

**Schema editor.** `/admin/schema` edits tables without touching the config by
hand — fields and types, required/unique/default, file limits and references,
the five rules, timestamps and extra indexes. Saving:

1. validates the whole config (cross-references included) and compiles every
   rule, so a typo cannot become an open table;
2. applies the same additive schema sync the server uses at boot;
3. rewrites the config file atomically and keeps the previous version as
   `<config>.bak`;
4. swaps the live schema, so new REST routes answer without a restart.

Removing a table from the config revokes its routes immediately but leaves the
SQLite table and its rows in place, so re-adding the same fields restores
access. Renaming or dropping a column is still a migration. The editor writes
what the file contained before defaults were applied, but any value that is not
plain data (functions, `process.env` lookups) is replaced by its resolved
value — review the diff. A deployment that embeds the app through `createApp()`
without a `configPath` gets a read-only editor.

**Access.** Only accounts with the `admin` role can sign in. The panel uses a
separate HttpOnly cookie session (8 hours by default), CSRF double-submit
tokens on every POST, `no-store` caching, and goes through the same CRUD
functions as the API — there is no second query path. Table rules still apply
unless `auth.adminBypassRules` is enabled. Row writes, logins and schema edits
are audited. There is no file upload support in the row form yet.

### Static frontend

Set `static` to serve a directory from the same process, on the same origin as
the API:

```ts
static: { dir: './public', spa: true, cacheControl: 'no-cache' },
```

- `dir` is resolved against the config file.
- `spa: true` returns `index.html` for unknown paths when the request accepts
  `text/html`, so client-side routes work without another server.
- `/api/*`, `/admin`, `/health`, `/version` and `/metrics` always win; an
  unknown API path still returns a JSON 404.
- Files outside the directory (including through symlinks) are never served.

There is no cross-origin setup needed: the browser calls `/api/v1/...` on the
same origin. A separate dev server (Vite, Next) still works — add its origin to
`allowedOrigins` or set `appUrl` to it.

### Generated API spec

`GET /api/v1/openapi.json` returns an OpenAPI 3.1 document generated from the
same config that drives routing: table schemas, create/update shapes, query
parameters, error responses, and auth paths. It cannot describe an endpoint
that does not exist.

### TypeScript SDK

```bash
npx mungilbase sdk                     # -> ./sdk/mungil-client.ts
npx mungilbase sdk ./sdk/client.ts     # explicit output
npm run sdk                            # from a source checkout
```

Generates a dependency-free typed client from the config: read/create/update
interfaces per table, `list/get/create/update/delete` methods, file upload and
download helpers, auth methods (`login`, `register`, `refresh`, `logout`, `me`),
and a typed `MungilApiError`. The generated file compiles on its own; CI
typechecks it on every run.

### MCP for AI agents

`npx mungilbase mcp` starts a Model Context Protocol server over stdio. It
exposes `list_tables`, `describe_table`, `list_rows`, `get_row`, `whoami`,
`get_openapi`, plus schema/OpenAPI resources, using the same CRUD functions and
row-level rules as the HTTP API. It is anonymous and read-only by default, and
every write tool documents its `{ row }` result shape.

```bash
# read-only, as one account, limited to two tables
npx mungilbase mcp --user agent@example.com --tables notes,posts

# add create_row / update_row / delete_row
npx mungilbase mcp --user agent@example.com --allow-write

# Supabase-style admin tools: migrations, users, backups, audit
npx mungilbase mcp --user admin@example.com --admin

# plus query_sql and execute_sql (bypasses table rules; audited)
npx mungilbase mcp --user admin@example.com --admin --allow-raw-sql
```

Defaults can live in the config file, so a client configuration stays short:

```ts
mcp: { user: 'agent@example.com', tables: ['notes', 'posts'], allowWrite: true },
```

Command-line flags win over the config. Two commands make setup and debugging
quick:

```bash
npx mungilbase mcp --check                 # initialize + tools/list + whoami, no pipe
npx mungilbase mcp --print-config opencode # ready-to-paste entry (claude, cursor, vscode, raw)
npx mungilbase mcp --print-config cursor --write
```

`--print-config` emits the real Node binary and the absolute CLI path, not
`npx`: the npm wrapper is an extra process in front of the server and some
clients do not forward stdio through it. If a client still shows nothing, the
server logs a hint to stderr after 10s of silence.

Admin mode requires an account whose role is `admin`; an agent cannot promote
itself. File uploads and config-file editing are still not exposed.
See [docs/mcp.md](docs/mcp.md) for Claude Desktop, Cursor and generic client
configuration, the security model, and programmatic use.

### Audit log

Security-relevant outcomes are appended to `_mungil_audit`: rule denials
(`rule_violation`), throttling (`rate_limited`), `401`s, server errors,
`auth.register` / `auth.login` / `auth.refresh` / `auth.logout` successes, and
`mcp.create` / `mcp.update` / `mcp.delete` writes (including denials). Each
row carries the request id, user id, table, operation, resource id and code.

```sql
SELECT created_at, event, outcome, code, table_name, operation, user_id
FROM _mungil_audit
ORDER BY id DESC
LIMIT 50;
```

The application never updates or deletes audit rows. An operator with direct
database access can, which is out of scope (see the threat model).

### Metrics and load shedding

`GET /metrics` exposes Prometheus text metrics: request counts and latency
histograms by matched route and status, auth failures, rule denials, DB and WAL
size, active sessions, uptime and memory. Set `MUNGIL_METRICS_TOKEN` to require
`Authorization: Bearer …` on the endpoint.

Requests beyond `server.maxConcurrency` (default 64) are rejected immediately
with `503 overloaded` and `Retry-After` instead of queueing. On a single SQLite
writer that is the difference between a slow service and a dead one.

Set `MUNGIL_SENTRY_DSN` to report unhandled errors and uncaught exceptions to a
Sentry-compatible endpoint. Without it, errors stay in the structured JSON log
with their request id.

Query params for `GET /api/v1/:table`: `filter` (a rule expression), `sort`
(`title` or `-title`), `limit` (1–200, default 50), `offset`. Newest first by
default.

Denials are explicit: `403 rule_violation` for writes your rules reject, and
`404 not_found` for rows your `view` rule does not let you see. There is no
case where a denied write silently reports success.

Errors always look like:

```json
{ "error": { "code": "rule_violation", "message": "…", "request_id": "…" } }
```

## Config

```ts
export default {
  appUrl: 'http://localhost:8787',   // your frontend origin
  allowedOrigins: [],                 // extra browser origins; empty = same-origin only
  static: { dir: './public', spa: true }, // serve a frontend from this process (optional)
  database: { file: './data/mungil.db' },
  storage: { local: { dir: './data/files' } }, // for file fields
  server: { host: '0.0.0.0', port: 8787, maxConcurrency: 64 },
  auth: { allowSignup: false, adminBypassRules: false }, // omit auth to disable it
  // Defaults for `mungilbase mcp`; flags still win.
  mcp: { user: 'agent@example.com', tables: ['posts'], allowWrite: false },
  // Optional. Enables password reset emails; password comes from MUNGIL_SMTP_PASSWORD.
  // email: { provider: 'smtp', from: 'noreply@example.com', smtp: { host: 'localhost', user: 'mailer' } },
  tables: [{
    name: 'posts',
    fields: [
      { name: 'author_id', type: 'text', required: true }, // an auth.uid value
      { name: 'title', type: 'text', required: true },
      { name: 'published', type: 'boolean', default: false },
      { name: 'cover', type: 'file', maxBytes: 2_000_000, allowedTypes: ['image/'] },
    ],
    rules: {
      list:   'published == true | auth.uid == author_id',
      view:   'published == true | auth.uid == author_id',
      create: 'auth.uid != null & author_id == auth.uid',
      update: 'auth.uid == author_id',
      delete: 'auth.uid == author_id',
    },
    // Optional indexes for hot filters. Removing one requires a migration.
    indexes: ['published', ['author_id', 'created_at']],
  }],
}
```

Relative paths (`database.file`, `storage.local.dir`, `static.dir`) resolve
against the config file, not the process working directory, so a client can
launch `mungilbase mcp` from anywhere and still open the same database.

A field with a non-null `default` is `NOT NULL` in SQLite and non-nullable in
the generated schemas: `published` is `boolean`, not `boolean | null`.

JSON configs are supported for deployments that cannot run a TypeScript
loader: see `mungil.config.example.json`.

## Rule language

Rules are small boolean expressions. They are parsed into an AST, compiled to
SQL with bound parameters, and never string-concatenated with values.

| | |
|---|---|
| Values | `'text'`, `42`, `1.5`, `true`, `false`, `null` |
| Auth | `auth.uid` (the signed-in user's id, or `null`), `auth.verified` (boolean) |
| Columns | bare names: `owner_id`, `published` |
| Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=` (null-safe) |
| Logic | `&` (AND), `\|` (OR), `!` (NOT) |
| Text | `~` (LIKE), `!~` (NOT LIKE), `\|\|` (concatenate) |
| Math | `+`, `-`, `*`, `/` |
| JSON | `->`, `->>` |
| Functions | `lower`, `upper`, `trim`, `ltrim`, `rtrim`, `length`, `substr`, `replace`, `coalesce`, `ifnull`, `abs`, `round`, `json_valid`, `json_extract`, `unixepoch` |

`==` compiles to SQLite `IS`, so `auth.uid == owner_id` is `NULL IS NULL` for
anonymous requests rather than an empty result.

## What works today

- [x] Typed, strict config schema with cross-reference validation
- [x] Rule expression parser + parameterized SQL compiler, with property tests
- [x] SQLite connection hardening (WAL, foreign keys, busy timeout)
- [x] Checksummed migrations with drift detection and transactional rollback
- [x] HTTP skeleton: health, version, JSON errors, request ids, security headers,
      closed-by-default CORS
- [x] Additive schema sync from `tables` (tables, indexes, nullable/defaulted
      columns), with loud refusal on destructive changes
- [x] Ruled CRUD: list, view, create, update, delete with `403 rule_violation`,
      filtering, sorting, pagination, typed input validation
- [x] Auth: Argon2id hashing, opaque DB-backed tokens, refresh rotation with
      family revocation, logout, per-account and per-IP login throttling
- [x] Self-service password reset via SMTP (or a development log provider),
      with hashed single-use tokens and full session revocation
- [x] Email verification with an optional login gate and `auth.verified` rules
- [x] OAuth login with Google and GitHub, linking by provider-verified email
- [x] Roles (`user`, `admin`) with explicit admin rule bypass
- [x] Web admin panel at `/admin`: browser first-run setup, data browser, schema
      editor that writes the config file, settings overview, CSRF-protected forms
- [x] File uploads to local or S3-compatible storage, with size/MIME limits,
      rule checks, automatic cleanup on replace/delete, and `files:gc`
- [x] OpenAPI 3.1 generated from the config at `/api/v1/openapi.json`
- [x] TypeScript SDK generated from the config (`npx mungilbase sdk`)
- [x] Append-only audit log for denials, throttling, 401s, 5xx, auth and admin events
- [x] Prometheus `/metrics`, load shedding, optional Sentry-compatible reporting
- [x] Verified online backups + automated restore drill (runs in CI)
- [x] `npx mungilbase` CLI (`init`, `start`, `migrate`, `doctor`, `openapi`,
      `sdk`, `backup`, `files gc`, `mcp`, user management) and a typed library export
- [x] MCP server for AI agents (stdio), rules-enforced, read-only by default,
      with optional identity/table allowlist/write tools and Supabase-style
      admin tools (migrations, users, backups, audit) plus opt-in raw SQL
- [x] GitHub Actions CI, npm release workflow, threat model, runbook

## Not built yet

- Upload malware scanning and per-account storage quotas
- Email deliverability tooling (bounces, complaints)
- External penetration test before a public launch

## Production gate

Every code-level requirement is met as of **v0.6.0**:

- [x] Argon2id password hashing (versioned PHC strings)
- [x] DB-backed sessions, refresh rotation with reuse detection, revocable
- [x] Login throttling per IP and per account; uniform errors; dummy verify
- [x] CORS closed by default
- [x] Exact role matching from a closed enum (`user` / `admin`), no substring checks
- [x] Rule denials return `403 rule_violation` and are written to the audit log
- [x] Rule compiler property-tested; no interpolation of values
- [x] Migrations checksummed, drift-detected, transactional
- [x] Backup + tested restore (`scripts/restore-drill.sh`, run in CI)
- [x] Structured logs, request ids, health/version, and opt-in Sentry-compatible error tracking
- [x] Capacity baseline at 100k rows, with composite-index guidance and a k6 harness
- [x] Threat model reviewed and maintained (`docs/threat-model.md`)

## Before a public launch

These are operational or third-party tasks, not code:

- [ ] External penetration test.
- [ ] A tested restore on the target host (snapshot or Litestream).
- [ ] An on-call/support commitment for the deployment.
- [ ] SMTP deliverability verified with the real provider (bounces, complaints).

See [docs/getting-started.md](docs/getting-started.md),
[docs/cli.md](docs/cli.md), [docs/mcp.md](docs/mcp.md),
[docs/threat-model.md](docs/threat-model.md),
[docs/architecture.md](docs/architecture.md) and
[docs/runbook.md](docs/runbook.md) (backups, restore, upgrades, incidents).

## Deploy (single node)

```bash
mkdir -p /srv/mungilbase && cd /srv/mungilbase
npm install --global mungilbase
mungilbase init
mungilbase doctor
mungilbase migrate
mungilbase start
```

Run it under a process manager. Example systemd unit:

```ini
[Unit]
Description=MungilBase
After=network.target

[Service]
Type=simple
User=mungil
WorkingDirectory=/srv/mungilbase
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/mungilbase start
Restart=on-failure
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Put a reverse proxy (Caddy, nginx) in front for TLS, and set `appUrl` plus
`allowedOrigins` to the public origin. SQLite lives in `./data` on the host;
schedule `mungilbase backup /backups` and read
[docs/runbook.md](docs/runbook.md). Before trusting any backup, run
`npm run drill` from a source checkout.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes the
package to npm when `NPM_TOKEN` is set.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

# CLI reference

The `mungilbase` CLI ships with the npm package and runs with `npx`, a global
install, or as a local dev dependency.

```bash
npx mungilbase <command> [options]
```

Requires Node.js 22.18 or newer.

## Install

Use it without installing:

```bash
npx mungilbase init
npx mungilbase start
```

Or install it in a project so the version is pinned:

```bash
npm install --save-dev mungilbase
npx mungilbase --version
```

A global install works too (`npm install -g mungilbase`), but a pinned local
dependency is easier to reproduce.

## Commands

| Command | What it does |
|---|---|
| `start` | Start the API server. This is the default when no command is given. |
| `dev` | Start, then restart and regenerate when the config file changes. |
| `init [dir]` | Write a starter config, `public/` page, `.env.example` and `.gitignore`. |
| `migrate` | Apply migrations and additively sync the schema. |
| `mcp` | Serve MCP tools for AI agents over stdio; `--check` and `--print-config` for setup. |
| `doctor` | Validate the config and every rule, then print a summary. No listener, no database writes. |
| `gen` | Write `openapi.json` when it is missing or stale. `--check` fails instead of writing. |
| `openapi [file]` | Write an OpenAPI 3.1 document (default `./openapi.json`). |
| `backup [dir\|file]` | Take a verified online backup (default `./backups`). |
| `files gc` | Find unreferenced uploads. Dry run unless `--apply` is passed. |
| `user create <email>` | Create an account. |
| `user passwd <email>` | Set a password and revoke all sessions for that account. |
| `user role <email> <role>` | Set `user` or `admin`. |
| `version` | Print the CLI version. |
| `help` | Print usage. |

## Global options

| Option | Meaning |
|---|---|
| `-c, --config <path>` | Config file. When omitted, see [config discovery](#config-discovery). |
| `--host <host>` | Listen address for `start`. Overrides `server.host`. |
| `--port <port>` | Listen port for `start`. Overrides `server.port`. |
| `-o, --output <path>` | Output path for `openapi`. |
| `--role <role>` | Role for `user create` (default `MUNGIL_USER_ROLE` or `user`). |
| `--password-env <name>` | Read a password from this environment variable instead of `MUNGIL_USER_PASSWORD`. |
| `--password-stdin` | `user create/passwd`: read the password from stdin. |
| `--generate-password` | `user create/passwd`: generate a password and print it once. |
| `--json` | `init`: write `mungil.config.json`; `doctor`: print JSON; `mcp --check`: JSON result. |
| `--force` | `init`: overwrite existing files. |
| `--apply` | `files gc`: actually delete unreferenced objects. |
| `--user <email>` | `mcp`: evaluate rules as this account (default anonymous). |
| `--tables <a,b>` | `mcp`: expose only these tables. |
| `--allow-write` | `mcp`: register create/update/delete tools. |
| `--admin` | `mcp`: register schema, user, backup and audit tools. Requires `--user` with the `admin` role. |
| `--allow-raw-sql` | `mcp`: expose `query_sql` and `execute_sql`. Requires `--admin`. |
| `--check` | `mcp`: run an in-memory initialize + `tools/list` + `whoami`; `gen`: exit 1 when files are stale. |
| `--print-config [client]` | `mcp`: print a ready-to-paste client entry (`opencode`, `claude`, `cursor`, `vscode`, `raw`). Defaults to `opencode`. |
| `--write` | `mcp --print-config`: merge the entry into the client config file. |
| `--demo` | `init`: scaffold the working todo example (migrate, seed, demo account). |
| `--demo-email <email>` | `init --demo`: account email (default `demo@example.com`). |
| `--env-file <path>` | Load environment variables from this file instead of `./.env`. |
| `-h, --help` | Show help. |
| `-v, --version` | Print the version. |

`--flag=value` is accepted as well as `--flag value`.

### Environment file

The CLI loads `./.env` when it exists, before anything reads configuration.
Real environment variables always win, so a shell export beats the file. Use
`--env-file <path>` (or `MUNGIL_ENV_FILE`) for another location. Values in a
`.env` file are available to `user create`, `MCP` and SMTP settings alike.

### Passwords

`user create` and `user passwd` accept a password four ways, in this order:

```bash
mungilbase user create me@example.com --generate-password   # printed once
printf %s "$PW" | mungilbase user create me@example.com --password-stdin
MUNGIL_USER_PASSWORD_FILE=./secret mungilbase user create me@example.com
MUNGIL_USER_PASSWORD=... mungilbase user create me@example.com
```

Prefer the first three: they keep the password out of shell history and `ps`.

## Config discovery

The first match wins:

1. `--config <path>` / `-c <path>`
2. `MUNGIL_CONFIG`
3. `mungil.config.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, or `.json` in the current directory

TypeScript configs are loaded with Node's built-in type stripping (Node
22.18+); you do not need a loader or a separate build step. JSON configs work
in containers that cannot run TypeScript. A config is a default export (or the root JSON object) and
is validated at startup — a typo fails the boot, not a request.

## `start`

```bash
mungilbase start
mungilbase start --port 9000 --host 127.0.0.1
mungilbase ./mungil.config.json     # path implies start
```

On boot it validates config and rules, checks that the port is free, applies
migrations, syncs the schema, then listens. The port check happens before the
database is opened: a second server on the same port fails without migrating a
database the first one is using. `SIGINT`/`SIGTERM` stop accepting requests,
finish in-flight work, close SQLite, and exit. `MUNGIL_DEBUG=1` prints a stack
trace on startup failure.

Run one server process per database. The MCP server is the intended exception:
it is a local operator surface that shares the file by design.

Container users can keep calling the entrypoint directly:

```bash
node dist/index.js ./mungil.config.json
```

## `init`

```bash
mungilbase init
mungilbase init ./services/api
mungilbase init --json
mungilbase init --force

# Working todo app: config + public/ + migrate + seed + demo account
mungilbase init --demo
mungilbase init --demo --demo-email me@example.com --json
```

The starter config defines one `notes` table with owner rules, turns on
signup, and serves `./public` from the same process. `init` writes
`public/index.html` (a small status page you can replace), so
`mungilbase start` serves a frontend and the API on one port. Existing files
are left alone unless `--force` is set; the command refuses to overwrite an
existing config without it.

`--demo` goes further: it defines a private `todos` table, serves a complete
todo UI, applies migrations, inserts three rows, and creates an account with a
generated password that is printed once. Use `user passwd` to set a known one.

After `init`:

```bash
mungilbase migrate     # not needed with --demo; it already migrated
mungilbase start
```

## `dev`

```bash
mungilbase dev
mungilbase dev --port 9000
```

Starts the server, writes `openapi.json`, then watches the config file. A
change restarts the server and regenerates the document (250 ms debounce).
`Ctrl+C` stops the server and the watcher. It does not watch `public/`: static
files are read per request, so a refresh is enough.

## `migrate`

```bash
mungilbase migrate
mungilbase migrate --config ./production.json
```

Applies every pending checksummed migration, then additively creates tables,
indexes and nullable/defaulted columns from `tables`. It never drops a column
or table; a destructive diff is an error that tells you to write a migration.

## `mcp`

```bash
mungilbase mcp
mungilbase mcp --user agent@example.com --tables notes,posts
mungilbase mcp --user agent@example.com --allow-write
mungilbase mcp --user admin@example.com --admin
mungilbase mcp --user admin@example.com --admin --allow-raw-sql
```

Starts a Model Context Protocol server over stdio for AI agents. The server is
anonymous and read-only by default. `--user` selects an existing account (the
same table rules apply); `--allow-write` registers `create_row`, `update_row`
and `delete_row`; `--tables` narrows the exposed surface.

`--admin` requires an account whose role is `admin` and registers operator
tools: `migrate`, `list_migrations`, user management, backups and audit
reads. `--allow-raw-sql` additionally exposes `query_sql` (read-only)
and `execute_sql` (arbitrary SQL). Both bypass table rules by design and are
audited.

Defaults can live in the config, and flags win:

```ts
mcp: { user: 'agent@example.com', tables: ['notes'], allowWrite: true },
```

Two commands replace guesswork when wiring up a client:

```bash
mungilbase mcp --check                      # in-process initialize + tools/list + whoami
mungilbase mcp --print-config opencode      # JSON entry, no pipe involved
mungilbase mcp --print-config cursor --write
```

`--print-config` uses the real Node binary and the absolute CLI path instead of
`npx`, because the npm wrapper adds a process in front of the server and does
not always forward stdio. `--write` merges the entry into an existing client
config (`opencode.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, or the Claude
Desktop file) and leaves every other key alone. It refuses to rewrite JSONC.

If a client connects but no request arrives, the server logs
`mcp_no_initialize` to stderr after 10 seconds with the npx hint.

Data tools reuse the HTTP CRUD functions. File uploads and config-file editing
are not exposed. stdout is reserved for the protocol, so all diagnostics go to
stderr. Write tools return `{ row }` and declare it as an `outputSchema`.

See [MCP for AI agents](mcp.md) for client configuration and the security
model.

## `doctor`

```bash
mungilbase doctor
mungilbase doctor --json
```

Parses the config, compiles every rule, and prints the resolved config path,
database path, app URL, static directory, auth/storage mode, `.env` file, MCP
defaults, generated-file freshness and tables. The database is never opened.
It also warns when the database lives on a WSL `/mnt/<drive>` mount or a
network share: SQLite WAL is not reliable there when more than one process
opens the file. Use it before deploying or after editing rules.

## `gen`

```bash
mungilbase gen
mungilbase gen --check
```

Writes `./openapi.json` from the current config. `--check` writes nothing: it
prints the stale path and exits `1`, so CI can fail a pull request that changed
the schema without regenerating. `dev` runs the write form on every config
change.

## `openapi`

```bash
mungilbase openapi
mungilbase openapi ./public/openapi.json
```

Writes an OpenAPI 3.1 document generated from the same config that drives
routing. It cannot describe an endpoint that does not exist. The server also
serves the live document at `GET /api/v1/openapi.json`.

## `backup`

```bash
mungilbase backup
mungilbase backup /backups
mungilbase backup /backups/snapshot.db
```

Uses SQLite's online backup API, so it is safe while the server runs, then
verifies the copy with `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
For continuous replication use Litestream; see [runbook](runbook.md).

## `files gc`

```bash
mungilbase files gc
mungilbase files gc --apply
```

Lists storage objects that no row references. This catches objects orphaned by
a crash between a row write and a delete. The dry run is the default because
deleting the wrong prefix is unrecoverable.

## Users

Passwords come from the environment, not from a command-line argument, so they
do not end up in shell history or `ps`:

```bash
export MUNGIL_USER_PASSWORD='correct horse battery'

mungilbase user create me@example.com
mungilbase user create boss@example.com --role admin
mungilbase user passwd me@example.com
mungilbase user role boss@example.com user
```

A password reset revokes every session for the account. Roles are read from
the database on every request, so a role change applies to existing tokens
immediately. Promotion alone does not bypass table rules unless
`auth.adminBypassRules` is enabled.

The first administrator does not need the CLI: a deployment with no `admin`
account shows a one-time setup screen at `/admin/setup`. `user create --role
admin` stays the headless and recovery path.

## Production environment

| Variable | Used by |
|---|---|
| `MUNGIL_CONFIG` | Config path |
| `MUNGIL_DB_FILE` | Override `database.file` |
| `MUNGIL_VERSION` | Version reported by `/version` and generated clients |
| `MUNGIL_DEBUG=1` | Full stack traces from the CLI |
| `MUNGIL_TRUST_PROXY=1` | Trust `X-Forwarded-For` from a reverse proxy |
| `MUNGIL_METRICS_TOKEN` | Require a bearer token on `GET /metrics` |
| `MUNGIL_SENTRY_DSN` | Sentry-compatible error reporting |
| `MUNGIL_USER_PASSWORD` | `user create` / `user passwd` |
| `MUNGIL_USER_ROLE` | Default role for `user create` |
| `MUNGIL_SMTP_PASSWORD` | SMTP password |

See [`.env.example`](../.env.example) for the full list.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Startup or command failure (invalid config, bad password, I/O error) |
| `2` | Usage error (unknown command or option, missing argument) |

## Using it as a library

The root export is the config schema and loader, server boot, OpenAPI builder
and CLI helpers. The MCP server is a subpath so the root import stays lean:

```ts
import { loadConfig, startServer, buildOpenApi } from 'mungilbase'
import type { MungilConfigInput } from 'mungilbase/config'
import { createMcpServer } from 'mungilbase/mcp'

const config = await loadConfig('./mungil.config.ts')
const spec = buildOpenApi(config, '0.8.0')

const server = await startServer({ configPath: './mungil.config.ts', handleSignals: false })
await server.close()

// The MCP entry point is also available through its subpath.
const mcp = createMcpServer({ config, registry, db, auth, version: '0.8.0' })
```

Importing the package never opens a database or starts a listener.

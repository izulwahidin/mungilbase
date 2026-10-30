# CLI reference

The `mungilbase` CLI ships with the npm package and runs with `npx`, a global
install, or as a local dev dependency.

```bash
npx mungilbase <command> [options]
```

Requires Node.js 22 or newer.

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
| `init [dir]` | Write a starter config, `.env.example` and `.gitignore`. |
| `migrate` | Apply migrations and additively sync the schema. |
| `mcp` | Serve MCP tools for AI agents over stdio. |
| `doctor` | Validate the config and every rule, then print a summary. No listener, no database writes. |
| `openapi [file]` | Write an OpenAPI 3.1 document (default `./openapi.json`). |
| `sdk [file]` | Generate the typed TypeScript client (default `./sdk/mungil-client.ts`). |
| `backup [dir\|file]` | Take a verified online backup (default `./backups`). |
| `files gc` | Find unreferenced uploads. Dry run unless `--apply` is passed. |
| `user create <email>` | Create an account. |
| `user passwd <email>` | Set a password and revoke all sessions for that account. |
| `user role <email> <role>` | Set `user` or `admin`. |
| `version` | Print the CLI version. |
| `help` | Print usage. |

Aliases kept for existing scripts: `serve`, `check`, `files-gc`,
`create-user`, `passwd`, `reset-password`, `set-role`.

## Global options

| Option | Meaning |
|---|---|
| `-c, --config <path>` | Config file. When omitted, see [config discovery](#config-discovery). |
| `--host <host>` | Listen address for `start`. Overrides `server.host`. |
| `--port <port>` | Listen port for `start`. Overrides `server.port`. |
| `-o, --output <path>` | Output path for `openapi` and `sdk`. |
| `--role <role>` | Role for `user create` (default `MUNGIL_USER_ROLE` or `user`). |
| `--password-env <name>` | Read a password from this environment variable instead of `MUNGIL_USER_PASSWORD`. |
| `--json` | `init`: write `mungil.config.json` instead of `mungil.config.ts`. |
| `--force` | `init`: overwrite existing files. |
| `--apply` | `files gc`: actually delete unreferenced objects. |
| `--user <email>` | `mcp`: evaluate rules as this account (default anonymous). |
| `--tables <a,b>` | `mcp`: expose only these tables. |
| `--allow-write` | `mcp`: register create/update/delete tools. |
| `--admin` | `mcp`: register schema, user, backup and audit tools. Requires `--user` with the `admin` role. |
| `--allow-raw-sql` | `mcp`: expose `query_sql` and `execute_sql`. Requires `--admin`. |
| `-h, --help` | Show help. |
| `-v, --version` | Print the version. |

`--flag=value` is accepted as well as `--flag value`.

## Config discovery

The first match wins:

1. `--config <path>` / `-c <path>`
2. `MUNGIL_CONFIG`
3. `mungil.config.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, or `.json` in the current directory

TypeScript configs are loaded in-process through `tsx`; you do not need to
install or run a separate build step. JSON configs work in containers that
cannot run a loader. A config is a default export (or the root JSON object) and
is validated at startup — a typo fails the boot, not a request.

## `start`

```bash
mungilbase start
mungilbase start --port 9000 --host 127.0.0.1
mungilbase ./mungil.config.json     # path implies start
```

On boot it validates config and rules, applies migrations, syncs the schema,
then listens. `SIGINT`/`SIGTERM` stop accepting requests, finish in-flight
work, close SQLite, and exit. `MUNGIL_DEBUG=1` prints a stack trace on startup
failure.

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
```

The starter config defines one `notes` table with owner rules and turns on
signup. Existing files are left alone unless `--force` is set; the command
refuses to overwrite an existing config without it.

After `init`:

```bash
mungilbase migrate
mungilbase start
```

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
tools: `migrate`, `list_migrations`, user management, backups, audit reads and
`generate_sdk`. `--allow-raw-sql` additionally exposes `query_sql` (read-only)
and `execute_sql` (arbitrary SQL). Both bypass table rules by design and are
audited.

Data tools reuse the HTTP CRUD functions. File uploads and config-file editing
are not exposed. stdout is reserved for the protocol, so all diagnostics go to
stderr.

See [MCP for AI agents](mcp.md) for client configuration and the security
model.

## `doctor`

```bash
mungilbase doctor
```

Parses the config, compiles every rule, and prints the resolved config path,
database path, app URL, auth/storage mode, and tables. Use it before deploying
or after editing rules.

## `openapi`

```bash
mungilbase openapi
mungilbase openapi ./public/openapi.json
```

Writes an OpenAPI 3.1 document generated from the same config that drives
routing. It cannot describe an endpoint that does not exist. The server also
serves the live document at `GET /api/v1/openapi.json`.

## `sdk`

```bash
mungilbase sdk
mungilbase sdk ./src/lib/mungil.ts
```

Generates a dependency-free TypeScript client: read/create/update interfaces
per table, `list/get/create/update/delete`, file upload/download, auth methods,
and a typed `MungilApiError`. The output compiles on its own.

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
| `MUNGIL_S3_ACCESS_KEY_ID` / `MUNGIL_S3_SECRET_ACCESS_KEY` | S3-compatible storage |
| `MUNGIL_GOOGLE_CLIENT_SECRET` / `MUNGIL_GITHUB_CLIENT_SECRET` | OAuth |

See [`.env.example`](../.env.example) for the full list.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Startup or command failure (invalid config, bad password, I/O error) |
| `2` | Usage error (unknown command or option, missing argument) |

## Using it as a library

The package also exports the config schema, config loader, server boot
function, OpenAPI builder and SDK generator:

```ts
import {
  loadConfig,
  startServer,
  generateSdk,
  buildOpenApi,
  openMcpContext,
} from 'mungilbase'
import type { MungilConfigInput } from 'mungilbase/config'

const config = await loadConfig('./mungil.config.ts')
const sdk = generateSdk(config)
const spec = buildOpenApi(config, '0.6.0')

const server = await startServer({ configPath: './mungil.config.ts', handleSignals: false })
await server.close()

// Build the MCP server without the stdio transport.
const mcp = await openMcpContext({ configPath: './mungil.config.ts', allowWrite: false })
await mcp.server.close()
mcp.db.close()
```

Importing the package never opens a database or starts a listener.

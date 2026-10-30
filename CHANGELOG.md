# Changelog

All notable changes to MungilBase. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `static: { dir, spa, cacheControl }` config: serve a frontend from the same
  process and origin as the API. `/api/*`, `/admin`, `/health`, `/version` and
  `/metrics` always win; traversal (including symlinks) is rejected; `spa`
  falls back to `index.html` only for requests that accept `text/html`. `init`
  now scaffolds `public/index.html` with it enabled.
- `init --demo [--demo-email <email>]`: scaffolds a working todo app, applies
  migrations, seeds three rows and creates an account with a generated password
  printed once.
- `mcp --check`: runs `initialize`, `tools/list` and `whoami` against the real
  server over an in-memory transport, and prints identity, access, tables and
  tools.
- `mcp --print-config <opencode|claude|cursor|vscode|raw> [--write]`: emits a
  client entry that uses the Node binary and absolute paths instead of `npx`,
  and merges it into an existing config without touching other keys.
- `mcp: { user, tables, allowWrite, admin, allowRawSql }` config defaults.
  Command-line flags still win, so a client entry can be just `mungilbase mcp`.
- MCP tools now declare `outputSchema`, and write tools document their
  `{ row }` result.
- `gen` writes `openapi.json` and the SDK together; `gen --check` exits 1 when
  either is stale. `dev` restarts and regenerates when the config changes.
- The CLI loads `./.env` when present (`--env-file <path>` / `MUNGIL_ENV_FILE`
  for another file). Real environment variables win.
- `user create|passwd --generate-password` (printed once), `--password-stdin`
  and `MUNGIL_USER_PASSWORD_FILE`. The missing-password error now lists them.
- `doctor` also reports the static directory, `.env` file, MCP defaults and
  generated-file freshness, and accepts `--json`.
- MCP logs `mcp_no_initialize` to stderr after 10s without a request, with the
  npx/stdio hint.
- `start` binds the port before opening the database and fails with a clear
  message when it is busy. A second instance can no longer run migrations
  against a database a live server is using.
- `doctor` warns when the database file is on a WSL `/mnt/<drive>` mount or a
  network share, where SQLite WAL can lose committed rows.
- `RunningServer.port` reports the bound port, not the requested one (so
  `port: 0` is usable from the library).

### Changed

- **Relative paths in the config (`database.file`, `storage.local.dir`,
  `static.dir`) now resolve against the config file, not the process working
  directory.** A client that launches `mungilbase mcp` from another directory
  no longer opens (or creates) a different database.
- A field with a non-null `default` is `NOT NULL` in SQLite and non-nullable in
  the generated OpenAPI/schema (`done` is `boolean`, not `boolean | null`).
  Existing columns are not altered; the change applies to new tables and new
  columns.
- `mcp --allow-write` with an anonymous identity now logs a warning: rules that
  compare `auth.uid` will deny the writes.
- Upgraded `zod` 3 → 4.6.7, `@hono/node-server` 1 → 2.1.5 and `vitest` 2 → 5.
- Removed the accidental `mungilbase` self-dependency from `dependencies`.

### Security

- `npm audit` is clean. This clears the `@hono/node-server` static-path
  advisory, the Vitest/tinypool/vite/esbuild dev-chain advisories, and the Zod
  constrained-collection advisory.

## [0.6.0] — 2026-10-30

### Added

- Supabase-style MCP admin mode: `npx mungilbase mcp --user admin@example.com --admin`.
  Tools include `get_config`, `database_info`, `list_migrations`, `migrate`,
  `list_users`, `create_user`, `set_user_role`, `reset_user_password`,
  `delete_user`, `list_audit`, `backup_database`, `files_gc` and `generate_sdk`.
- `--allow-raw-sql` adds `query_sql` (read-only, row-capped) and `execute_sql`
  (arbitrary SQL). It requires `--admin` and an account with the admin role.
- Admin and raw-SQL calls are written to the audit log as `mcp.admin.*` events.
- Generated passwords for `create_user` / `reset_user_password` are returned
  once when the caller omits a password.

### Changed

- `whoami` reports whether admin mode and raw SQL are enabled.
- `AuthService` gained `listUsers` and `deleteUser` for operator surfaces.


### Removed

- Docker deployment artifacts (`Dockerfile`, `docker-compose.yml`,
  `.dockerignore`, `litestream.yml`) and the GHCR image jobs. The supported
  deployment is the npm package / `npx mungilbase` process under a process
  manager; Litestream is documented as an optional external backup tool.


## [0.5.0] — 2026-10-30

### Added

- MCP server for AI agents: `npx mungilbase mcp` speaks the Model Context
  Protocol over stdio. Read tools (`whoami`, `list_tables`, `describe_table`,
  `list_rows`, `get_row`, `get_openapi`) and schema/OpenAPI resources are
  always available; `--allow-write` adds `create_row`, `update_row` and
  `delete_row`.
- MCP reuses the HTTP CRUD functions, so table rules, validation, timestamps
  and constraints apply identically. Read-only and anonymous by
  default; `--user <email>` selects the account used for rule evaluation and
  `--tables` narrows the exposed surface.
- `mungilbase/mcp` export and `openMcpContext`/`createMcpServer` for embedding
  the MCP server in another process.
- `AuthService.findUserByEmail` for operator-controlled identity resolution.
- Docs: `docs/mcp.md` with Claude Desktop, Cursor and generic client setup.

### Changed

- Bumped `zod` to 3.25 for compatibility with the MCP SDK.

## [0.4.0] — 2026-10-30

### Added

- `npx mungilbase` CLI: `init`, `start`, `migrate`, `doctor`, `openapi`, `sdk`,
  `backup`, `files gc`, and `user create|passwd|role`.
- `init` scaffolds a runnable project (`mungil.config.ts`, `.env.example`,
  `.gitignore`), with `--json` for configs that cannot run a TS loader.
- TypeScript configs are loaded in-process through `tsx`, so the published
  package needs no separate build or loader setup.
- Config discovery across `mungil.config.{ts,mts,js,mjs,cjs,json}`, with
  `MUNGIL_CONFIG` and `--config` taking precedence.
- Typed library entrypoint (`mungilbase` and `mungilbase/config`) exporting the
  config schema, loader, server boot, OpenAPI builder and SDK generator.
- npm publish job on `v*` tags, plus package/CLI smoke checks in CI.

### Changed

- The server boot path is shared by the CLI, the Docker entrypoint and library
  users (`src/server.ts`), instead of living in `src/index.ts`.
- `package.json` is publishable: `bin`, `exports`, `files`, and `tsx` moved to
  runtime dependencies.

## [0.3.0] — 2026-10-30

### Added

- S3-compatible storage (AWS S3, Cloudflare R2, MinIO) alongside local disk,
  with prefix scoping and credentials read only from environment variables.
- Automatic file cleanup when a row is deleted or a file is replaced, plus
  `npm run files:gc` to collect unreferenced objects (dry run by default).
- `npm run sdk` generates a dependency-free typed TypeScript client from the
  config; CI regenerates and typechecks it.
- 100,000-row performance baseline; composite-index guidance for filter+sort
  queries.

### Changed

- Schema sync and uploads delete replaced files; deleting a row now removes its
  stored objects.

## [0.2.0] — 2026-10-30

### Added

- Self-service password reset: `POST /api/v1/auth/request-password-reset` and
  `POST /api/v1/auth/reset-password`. Hashed, single-use tokens with a 30-minute
  default TTL; reset revokes every session for the account.
- `email` config with `smtp` and development `log` providers; the log provider
  is refused when `NODE_ENV=production`.
- Per-address and per-IP throttles for reset requests, and audit events
  `auth.password_reset_requested` / `auth.password_reset`.
- Roles (`user`, `admin`) stored on the account and resolved on every request,
  `npm run user:role` to change one, and `auth.adminBypassRules` (default
  false) to make admins skip table rules.
- Server-rendered admin panel at `/admin`: login, table browse, create/edit/
  delete rows, separate HttpOnly cookie session, CSRF tokens, HTML escaping,
  and audit events for admin access and writes.
- File fields with local storage, per-field size and MIME limits, update-rule
  authorization on upload, view-rule authorization on download, sandboxing CSP,
  and `file.upload` audit events.
- Optional Sentry-compatible error reporting via `MUNGIL_SENTRY_DSN`, covering
  request errors and uncaught process exceptions.
- Email verification: hashed single-use tokens, optional `required` login gate,
  resend endpoint with throttling, `auth.verified` exposed to rules, and
  verification links delivered through the existing mailer.
- OAuth login with Google and GitHub: state-cookie CSRF protection, verified
  email linking, token return in the redirect fragment, and account creation
  for first-time users.

## [0.1.0] — 2026-10-29

First usable release. Single node, SQLite, invite-only by default.

### Backend

- Typed `mungil.config.ts` (or JSON) schema with table, field, rule, index and
  auth validation; all five rules required per table.
- Rule DSL compiled to parameterized SQL: `==`, `!=`, `<`, `<=`, `>`, `>=`,
  `&`, `|`, `!`, `~`, `!~`, `||`, `+`, `-`, `*`, `/`, `->`, `->>`, plus an
  allowlisted function set.
- Additive schema sync: tables, nullable/defaulted columns, foreign keys,
  unique fields, `created_at` index, configured indexes. Destructive changes
  fail at boot with an explicit migration message.
- Checksummed migration runner with drift detection and transactional rollback.
- Ruled CRUD: list, view, create, update, delete. Create rules insert through a
  guarded CTE and return `403 rule_violation`; update/delete use the view rule
  to choose between `403` and `404`.
- Filtering, sorting, pagination; typed input validation; JSON/boolean round
  trips; conflict and foreign-key mapping.
- Argon2id passwords, opaque 256-bit access/refresh tokens stored as SHA-256,
  single-use refresh rotation with family revocation, immediate logout.
- Per-account and per-IP login throttling persisted in SQLite.
- Append-only audit log for denials, throttling, `401`s, `5xx` and auth events.
- OpenAPI 3.1 generated from config at `GET /api/v1/openapi.json`.
- Prometheus metrics at `GET /metrics` (optional bearer token), concurrency
  shedding with `503 overloaded`, request ids and structured JSON logs.

### Operations

- `npm run backup` — verified online SQLite snapshot.
- `npm run drill` — backup/restore drill, also run in CI.
- `npm run user:create`, `npm run user:passwd`.
- `npm run bench` and `scripts/loadtest.k6.js`, `scripts/seed.ts`.
- Dockerfile, compose file, Litestream example, runbook and threat model.

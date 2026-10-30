# Changelog

All notable changes to MungilBase. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

# Changelog

All notable changes to MungilBase. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

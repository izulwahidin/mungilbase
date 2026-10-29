# MungilBase

**mungil** *(Indonesian)* — tiny, small.

A small, self-hosted backend defined by one typed config file: REST endpoints,
authentication, row-level rules, and migrations. Runs as a single Node process
with SQLite.

> **Status: v0.1 scaffold.** This repository is the start of a rebuild, not a
> finished product. See [What works today](#what-works-today) and the
> [production gate](#production-gate) before you rely on it.

## Why

Existing "config as backend" tools are excellent, but each asks for a trade:
a hosted platform, a VPS and an admin UI, or a serverless database with
transactional gaps. MungilBase is deliberately the boring option:

- **One process, one file.** Node + SQLite in WAL mode. Your data is a file you
  can copy, and `docker compose up` is the whole deploy.
- **Real transactions.** Sessions, rule-checked writes, and migrations run
  inside SQLite transactions, not eventually-consistent stores.
- **Rules are SQL.** Access rules compile to parameterized `WHERE` clauses and
  execute inside the database, so unauthorized rows never leave it.
- **Deny by default.** Every table must declare all five rules; `null` is
  deny, `'true'` is allow, and there is no implicit "open" state.

## Quick start

```bash
npm install
npm run dev
curl localhost:8787/health
curl localhost:8787/version
```

The example config (`mungil.config.ts`) describes `posts`. It is validated at
boot; a typo is a startup error, not a runtime surprise.

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

curl -X POST localhost:8787/api/v1/posts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"author_id\":\"$USER_ID\",\"title\":\"Hello\"}"
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

### Files

A `file` field stores a storage key. Two routes handle it:

| Method | Path | Rule applied |
|---|---|---|
| `POST` | `/api/v1/:table/:id/files/:field` | `update`, multipart field `file` |
| `GET` | `/api/v1/:table/:id/files/:field` | `view` |

Uploads are limited by the field's `maxBytes` (5 MB default) and
`allowedTypes` MIME prefixes (`['image/']` default). The file is written before
the row update; if the update rule denies, the file is deleted again. Files live
outside the database (`storage.local.dir`, default `./data/files`), so back them
up separately from SQLite. Deleting a row does not delete its files yet.

Sessions are opaque 256-bit tokens stored as SHA-256 hashes in SQLite, not
JWTs. That makes logout and revocation immediate instead of "eventually, when
the token expires". Refresh tokens are single-use: replaying a rotated token
revokes the entire session family.

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
created with `user:create` start verified, since the operator vouched for them.

Users have a closed role: `user` or `admin`. Promotion alone does **not**
bypass table rules; set `auth.adminBypassRules: true` if admins should see and
write everything. Roles are read from the database on every request, so a
change applies to already-issued tokens immediately.

```bash
npm run user:role -- me@example.com admin
```

### Admin panel

Server-rendered at `/admin`, no build step. Only accounts with the `admin` role
can sign in. It uses a separate HttpOnly cookie session (8 hours by default),
CSRF double-submit tokens, and goes through the same CRUD functions as the API —
there is no second query path. Table rules still apply unless
`auth.adminBypassRules` is enabled.

It can list, create, edit and delete rows. There is no file upload support yet.

### Generated API spec

`GET /api/v1/openapi.json` returns an OpenAPI 3.1 document generated from the
same config that drives routing: table schemas, create/update shapes, query
parameters, error responses, and auth paths. It cannot describe an endpoint
that does not exist.

### Audit log

Security-relevant outcomes are appended to `_mungil_audit`: rule denials
(`rule_violation`), throttling (`rate_limited`), `401`s, server errors, and
`auth.register` / `auth.login` / `auth.refresh` / `auth.logout` successes. Each
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
  database: { file: './data/mungil.db' },
  storage: { local: { dir: './data/files' } }, // for file fields
  server: { host: '0.0.0.0', port: 8787, maxConcurrency: 64 },
  auth: { allowSignup: false, adminBypassRules: false }, // omit auth to disable it
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

JSON configs are supported for production containers that cannot run a build
step: see `mungil.config.example.json`.

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
- [x] Server-rendered admin panel at `/admin` with CSRF-protected forms
- [x] File uploads to local storage with size/MIME limits and rule checks
- [x] OpenAPI 3.1 generated from the config at `/api/v1/openapi.json`
- [x] Append-only audit log for denials, throttling, 401s, 5xx, auth and admin events
- [x] Prometheus `/metrics`, load shedding, optional Sentry-compatible reporting
- [x] Verified online backups + automated restore drill (runs in CI)
- [x] Docker image, compose file, CI workflow, threat model, runbook

## Not built yet

- SDK codegen, S3-compatible storage, upload malware scanning
- Orphaned-file cleanup after row deletes
- External penetration test before a public launch

## Production gate

A release is not "production-ready" until all of these are true:

- [x] Argon2id password hashing (versioned PHC strings)
- [x] DB-backed sessions, refresh rotation with reuse detection, revocable
- [x] Login throttling per IP and per account; uniform errors; dummy verify
- [x] CORS closed by default
- [ ] Exact role matching from a closed enum (roles are not implemented yet)
- [x] Rule denials return `403 rule_violation` and are written to the audit log
- [x] Rule compiler property-tested; no interpolation of values
- [x] Migrations checksummed, drift-detected, transactional
- [x] Backup + tested restore (`scripts/restore-drill.sh`, run in CI)
- [x] Structured logs, request ids, health/version, and opt-in Sentry-compatible error tracking
- [ ] Load test against a realistic dataset; N+1 and index review
- [ ] Threat model reviewed; external penetration test before public launch

See [docs/threat-model.md](docs/threat-model.md),
[docs/architecture.md](docs/architecture.md) and
[docs/runbook.md](docs/runbook.md) (backups, restore, upgrades, incidents).

## Deploy (single node)

```bash
cp mungil.config.example.json mungil.config.json
docker compose up -d --build
```

Pushing a `v*` tag builds and publishes `ghcr.io/<owner>/mungilbase:<tag>`
via `.github/workflows/release.yml`.

SQLite lives in `./data` on the host. Schedule `npm run backup -- /backups`
and read [docs/runbook.md](docs/runbook.md); for continuous replication use the
Litestream block in `docker-compose.yml`. Before trusting any backup, run
`npm run drill`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

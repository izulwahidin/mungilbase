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

Create an account (signup is closed by default):

```bash
MUNGIL_USER_PASSWORD='correct horse battery' npm run user:create -- me@example.com
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
| `POST` | `/api/v1/auth/logout` | `204`, revokes the session |
| `GET` | `/api/v1/auth/me` | current user; `401` without a token |

Sessions are opaque 256-bit tokens stored as SHA-256 hashes in SQLite, not
JWTs. That makes logout and revocation immediate instead of "eventually, when
the token expires". Refresh tokens are single-use: replaying a rotated token
revokes the entire session family.

Auth users live in internal `_mungil_*` tables. They are not config tables, so
a `user_id` column in your schema is a plain text reference to `auth.uid`, not
a foreign key.

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
  server: { host: '0.0.0.0', port: 8787 },
  auth: { allowSignup: false },       // omit to disable /api/v1/auth entirely
  tables: [{
    name: 'posts',
    fields: [
      { name: 'author_id', type: 'text', required: true }, // an auth.uid value
      { name: 'title', type: 'text', required: true },
      { name: 'published', type: 'boolean', default: false },
    ],
    rules: {
      list:   'published == true | auth.uid == author_id',
      view:   'published == true | auth.uid == author_id',
      create: 'auth.uid != null & author_id == auth.uid',
      update: 'auth.uid == author_id',
      delete: 'auth.uid == author_id',
    },
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
| Auth | `auth.uid` (the signed-in user's id, or `null`) |
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
- [x] OpenAPI 3.1 generated from the config at `/api/v1/openapi.json`
- [x] Append-only audit log for denials, throttling, 401s, 5xx and auth events
- [x] Docker image, compose file, CI workflow, threat model

## Not built yet

- Admin UI, file uploads, SDK codegen
- Password reset, email verification, OAuth
- Roles beyond `authenticated` (`auth.uid` only)

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
- [ ] Backup + **tested** restore documented and exercised
- [ ] Structured logs, request ids, health/version, error tracking
- [ ] Load test against a realistic dataset; N+1 and index review
- [ ] Threat model reviewed; external penetration test before public launch

See [docs/threat-model.md](docs/threat-model.md) and
[docs/architecture.md](docs/architecture.md).

## Deploy (single node)

```bash
cp mungil.config.example.json mungil.config.json
docker compose up -d --build
```

SQLite lives in `./data` on the host. For continuous backup, see the Litestream
block in `docker-compose.yml`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

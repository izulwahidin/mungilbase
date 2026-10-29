# Architecture

## Shape

```
             ┌──────────── HTTP (Hono) ─────────────┐
request ───▶ │ request id → log → headers → CORS    │
             │ ↓                                    │
             │ routes → validation (zod)            │
             │ ↓                                    │
             │ rules → compiled SQL + params        │
             │ ↓                                    │
             │ transaction ──────────────┐          │
             └───────────────────────────┼──────────┘
                                         ▼
                                   SQLite (WAL)
```

One process. One database file. No queues, no caches, no second service to
operate. That is the feature.

## Modules

| Path | Responsibility | Rule |
|---|---|---|
| `src/config/` | Schema, loading, startup validation | Nothing else parses config |
| `src/db/` | Connection, transactions, migrations | Owns every `PRAGMA` and `BEGIN` |
| `src/sql/expr/` | Rule DSL → AST → parameterized SQL | Pure; no DB, no HTTP, no config |
| `src/sql/query/` | Query builders | Only place that writes SQL strings (v0.2) |
| `src/http/` | Routing, errors, middleware | No SQL strings |
| `src/auth/` | Argon2id, opaque tokens, sessions, throttling | Owns its internal tables; never interpolates user input into SQL |
| `src/audit/` | Append-only security events | Never throws; no update/delete path |
| `src/openapi/` | OpenAPI 3.1 generation from config | Pure; no DB, no HTTP |

## Invariants

1. **Values are bound, never interpolated.** Any user-controlled value reaches
   SQLite as a `?` parameter. Identifiers are validated against the schema and
   quoted; they are never taken from request input without an allowlist.
2. **Rules execute in the database.** A rule compiles to a boolean expression
   appended to the query's `WHERE`. Filtering in application code would mean
   unauthorized rows entered memory.
3. **Deny is explicit.** Every table declares `list`, `view`, `create`,
   `update`, `delete`. `null` denies. A missing rule fails at startup.
4. **Migrations are immutable.** Applied SQL is checksummed. Editing history is
   a startup error; forward-only is the default path.
5. **Transactions own consistency.** Multi-statement operations run in a single
   `IMMEDIATE` transaction. There is no "best effort" write.
6. **Errors are typed.** Clients see `{ error: { code, message, request_id } }`
   and can branch on `code`. Details stay in logs.

## How a rule becomes SQL

Rule: `published == true | auth.uid == author_id`

```text
jsep ─▶ BinaryExpression(|)
          ├── BinaryExpression(==)  published, true
          └── BinaryExpression(==)  auth.uid, author_id
```

Compiled with `auth.uid = 'user_1'`:

```sql
(("published" IS ?) OR (? IS "author_id"))
-- params: [true, 'user_1']
```

Notes:

- `==` → `IS`, so `NULL` comparisons are explicit rather than silently false.
- `auth.uid` is bound as a parameter even though it comes from a signed token.
- Functions are a closed allowlist; unknown names are rejected at boot.
- Bare `true`/`false`/`null` rules become `1`/`0` so the planner can skip work.

Denied writes surface as `403 rule_violation`, not as a zero-row success. The
insert path inserts through a CTE guarded by the rule and checks `RETURNING` —
no row back means denied. Updates and deletes use the view rule to choose
between `403` and `404`.

## Auth

- **Opaque tokens, not JWTs.** A login issues a 256-bit random access token and
  refresh token. Only their SHA-256 digests are stored, so a database leak does
  not yield live sessions.
- **Immediate revocation.** Every request resolves the access token against
  `_mungil_auth_tokens` joined to `_mungil_auth_sessions`. Logout deletes the
  session's tokens; nothing stays valid until an expiry you cannot control.
- **Single-use refresh tokens.** Rotation happens in one `IMMEDIATE`
  transaction. Replaying a used token revokes every session in the family,
  including the one the legitimate client is using.
- **Session lifetime.** The session's absolute expiry is fixed at creation
  (`maxSessionTtlSeconds`); refreshing slides the refresh token only up to that
  cap.
- **Throttling.** Fixed-window counters live in SQLite so a restart cannot reset
  an attacker's budget. Account and IP windows are separate.
- **Passwords.** Argon2id (19 MiB, t=2, p=1) with PHC-encoded hashes, so the
  parameters travel with each hash and can be upgraded lazily.
- **Unknown accounts** still pay a dummy Argon2 verification, and both failure
  paths return the same `401 invalid credentials`.

## Audit

`_mungil_audit` is append-only and written synchronously in the same SQLite
file. That keeps an audit row and the outcome it describes consistent even if
the process dies immediately afterwards, at the cost of one small insert on
denials and auth events.

Written events:

- `http.denied` with `rule_violation`, `rate_limited` or `unauthorized`
- `http.error` for unexpected `5xx`
- `auth.register`, `auth.login`, `auth.refresh`, `auth.logout` successes

Not written: validation failures, 404s for invisible rows, and reads. Those are
either noise or would themselves leak whether a row exists. Reads of denied
rows are invisible by design; the 404 is the correct signal.

The audit write is wrapped so that a locked or missing table logs to stderr and
the original response is preserved. An audit outage must not become a 500.

## OpenAPI

`GET /api/v1/openapi.json` builds the document from `MungilConfig` on each
request (cheap, and impossible to drift). It is registered before `/:table` so
it cannot be shadowed. The spec is intentionally generated, not hand-written:
hand-maintained specs are the first thing to rot.

## Error contract

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Validation failed; `details` lists fields |
| 401 | `unauthorized` | Missing or invalid credentials |
| 403 | `forbidden` | Authenticated but not allowed by role |
| 403 | `rule_violation` | Denied by a table rule |
| 404 | `not_found` | Route or record missing |
| 409 | `conflict` | Unique constraint or version conflict |
| 500 | `internal` | Bug; a request id is logged with the stack |

## Database conventions

- Table and column names: `snake_case`, lowercase, validated by regex.
- Primary key: `id TEXT PRIMARY KEY` (uuid v7 later, random hex now).
- Timestamps: `created_at` / `updated_at`, UTC ISO-8601 text.
- Booleans: `INTEGER` 0/1, `CHECK (col IN (0, 1))`.
- JSON: `TEXT` with `json_valid()` check.
- No triggers for business logic in v0.1; the engine writes timestamps.

## Non-goals

- An ORM. Query builders plus typed row results are enough at this size.
- A plugin system. Extensibility means editing the source, which is auditable.
- Multi-tenancy. One deployment serves one application.

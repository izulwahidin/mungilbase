# Threat model

Scope: a single MungilBase deployment — one Node process, one SQLite file, one
operator. Multi-tenancy, clustering, and managed hosting are explicitly out of
scope for v0.1.

This is a living document. Every claim below is either enforced by code and a
test, or marked as planned.

## Assets

| Asset | Why it matters |
|---|---|
| User credentials | Reused passwords; a leak harms users elsewhere |
| Session / refresh tokens | Full account takeover if stolen |
| Row data | May be private per user or per table |
| SQLite file | Everything, including hashes and sessions |
| Config file | Rules and secrets references; changing it changes access |
| Admin access | Read/write across all tables |

## Actors

| Actor | Capability |
|---|---|
| Anonymous internet | Can reach any public route; fully untrusted |
| Authenticated user | Holds a valid access token; untrusted input |
| Table owner | May create/update their own rows |
| Operator | Controls the host, config, and environment |
| Compromised dependency | Runs inside the process |

## Trust boundaries

1. **HTTP → application.** All headers, paths, query strings, and bodies are
   untrusted until validated.
2. **Application → SQLite.** Rules and filters become SQL. This boundary is
   where injection and rule-bypass bugs live.
3. **Config → application.** Trusted at boot, but still validated: a typo that
   silently opens a table is a vulnerability, not a config error.
4. **Process → filesystem.** Only the operator writes the config and database
   path; the app writes only the database and uploads.
5. **Operator → secrets.** Secrets arrive from environment variables, never
   from the config file.

## Threats and status

Legend: **done** = enforced and tested; **planned** = scheduled before public
launch; **out** = deliberately not handled.

### Spoofing

| Threat | Status | Mitigation |
|---|---|---|
| Forged session token | done | 256-bit random opaque tokens; only SHA-256 hashes stored; no JWT, no signing secret to leak |
| Stolen refresh token reuse | done | Single-use rotation; replay revokes the whole family inside one transaction |
| Session fixation | done | Server-issued session ids; clients cannot supply or choose them |
| Bearer token in URL | done | Tokens accepted only from the `Authorization` header |
| Password reset token theft | done | 256-bit tokens hashed at rest, single-use, 30 min default TTL, replaced on re-request, reset revokes all sessions |
| Reset link leaking through logs | done | The `log` email provider is refused when `NODE_ENV=production` |

### Tampering

| Threat | Status | Mitigation |
|---|---|---|
| SQL injection via rules | done | Rules parsed to an AST; identifiers validated against the table; all values bound as `?` |
| SQL injection via filters/sort | done | Filters use the same compiler; sort columns are allowlisted against the table schema |
| Rule bypass via create | done | Insert rules compile to a `WITH … INSERT … SELECT … WHERE` guard; denied rows insert nothing and the API returns `403 rule_violation` |
| Rule bypass via update/delete | done | The rule is part of the `WHERE`; `view` decides between `403` and `404`, so there is no existence oracle |
| Migration drift | done | SHA-256 checksums; unknown or edited migrations abort startup |
| Malicious config | done (partial) | Strict schema, all five rules required, reference checks |
| CSRF against the admin panel | done | Double-submit token on every POST, `SameSite=Lax` cookies, no CORS on `/admin` |
| XSS in the admin panel | done | All rendered values are HTML-escaped; no client-side JS is shipped |
| Path traversal through upload keys | done | Keys are generated server-side, matched against a strict pattern, and resolved under the storage root |
| Malicious file content | partial | Per-field size and MIME-prefix limits, sandboxing CSP and `nosniff`; no magic-byte sniffing or malware scan |

### Repudiation

| Threat | Status | Mitigation |
|---|---|---|
| Denied access without a trace | done | `_mungil_audit` rows for `rule_violation`, `rate_limited`, `unauthorized` and `5xx`, with request id, user id, table, operation and resource id |
| Admin changes untraceable | out of scope | No admin surface in v0.1; direct operator database access is outside the threat model |
| Audit tampering by the application | done (design) | The app has no update or delete path for `_mungil_audit`; an operator with file access can still edit it |

### Information disclosure

| Threat | Status | Mitigation |
|---|---|---|
| Reading another user's rows | done | Rules compile into the `WHERE` clause, executed in SQLite, with a real token as `auth.uid` |
| Enumeration of accounts | done (login), partial (reset) | Login returns identical `401` and pays a dummy Argon2 verification. Reset returns uniform `202`, but known addresses cost an email send, so timing can differ |
| Password reset abuse | done | Per-address (3/hour) and per-IP (15/hour) throttles persisted in SQLite |
| Hashes leaked by a view rule | done | Auth users live in `_mungil_auth_users`, never in a config table; no route returns `password_hash` |
| Stack traces in responses | done | Generic `internal` error; details go to logs only |
| Request id injection into logs | done | Supplied ids must match a bounded charset |
| Traffic stats exposed via `/metrics` | partial | Counts and latencies by route, no row data; set `MUNGIL_METRICS_TOKEN` to require a bearer token |
| Error data sent to a third party | out (opt-in) | Only when `MUNGIL_SENTRY_DSN` is set; message, stack and request context, never request bodies |
| Timing side channel on token compare | done (design) | Tokens are looked up by SHA-256 digest; there is no secret comparison to leak |
| Access token theft | partial | Short TTL (15 min default), revocable sessions, family revocation on refresh reuse |

### Denial of service

| Threat | Status | Mitigation |
|---|---|---|
| Password-cost exhaustion | done (bounded) | Fixed Argon2id cost, login throttling, and `server.maxConcurrency` shedding with `503` |
| Login brute force | done | Fixed windows per account (5/15 min) and per IP (30/10 min), counters persisted in SQLite; `Retry-After` returned |
| Query flood / slow filters | done (bounded) | Concurrency cap sheds excess with `503 overloaded`; filters on hot columns should be indexed via config |
| Storage exhaustion via uploads | partial | Per-file `maxBytes` and MIME allowlists; no per-account quota and no orphan cleanup job yet |
| Oversized expressions | done | 2,000 character rule cap, 64-level nesting cap |
| Large request bodies | done | 1 MB cap enforced before parsing, plus a post-read byte check |
| Connection exhaustion | done (single node) | `busy_timeout`, WAL, single-process writes, and load shedding |

### Elevation of privilege

| Threat | Status | Mitigation |
|---|---|---|
| Admin role spoofing | done | Roles are a closed enum (`user`, `admin`) stored in the users table, read per request, exact match only. There is no role claim to forge |
| Implicit admin bypass | done | `auth.adminBypassRules` defaults to false; promotion alone never disables rules |
| Admin actions unaudited | done | `auth.admin_login`, `auth.admin_logout`, `admin.create`, `admin.update`, `admin.delete` are written to `_mungil_audit` |
| Admin panel cookie theft | partial | HttpOnly + `SameSite=Lax`, `Secure` when `appUrl` is HTTPS, 8-hour lifetime, revocable; no device binding |
| Extension/config escape hatch | out | There is no plugin system in v0.1, by design |

## Out of scope for v0.1

- Multi-tenant isolation within one deployment
- Horizontal scaling and read replicas
- Protection against a compromised host or operator
- File-upload malware scanning
- DDoS at the edge (deploy behind a proxy/CDN if needed)
- SOC 2 / ISO 27001 certification

## Open questions to resolve before launch

1. Email verification and OAuth are not implemented. Password reset is, when
   `email` is configured; otherwise a locked-out user needs `user:passwd`.
2. Is `auth.uid == null` matching rows with `owner_id IS NULL` intended? The
   current compiler says yes (SQLite `IS`). Confirm before shipping rules that
   allow null owners.
3. Argon2id parameters are fixed at 19 MiB / t=2 / p=1. Benchmark on the target
   host and record the p95 login time in the runbook.
4. There is no global concurrency cap around password hashing. If the host is
   small, put a request concurrency limit in front of the process.
5. Audit rows grow without bound. Decide a retention/export policy before a
   long-running deployment; the table is not rotated automatically.

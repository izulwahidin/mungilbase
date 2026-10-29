# Runbook

Operational guide for a single MungilBase deployment: one Node process, one
SQLite file, one operator.

**Assumptions**

- One process per database file. Do not run two containers against the same
  file, especially on a network filesystem.
- The host's disk is encrypted if the data is sensitive. MungilBase does not
  encrypt the database file itself.
- SQLite is the only supported database engine in v0.1.

**Recovery targets**

| | |
|---|---|
| RPO with 30-minute snapshots | 30 minutes |
| RPO with Litestream | seconds |
| RTO, restore from snapshot | ~5 minutes |
| RTO, restore from Litestream | ~15 minutes |

---

## Daily checks

1. `GET /health` returns `200` and `status: "ok"`. A `503` means the process
   cannot read the database; check disk and file permissions first.
2. `GET /version` matches the deployed release.
3. Disk usage on the data volume. SQLite needs room for `-wal`/`-shm` and for
   the largest transaction.
4. Audit spikes:

   ```sql
   SELECT event, code, COUNT(*) AS n
   FROM _mungil_audit
   WHERE created_at > datetime('now', '-1 day')
   GROUP BY event, code
   ORDER BY n DESC;
   ```

5. Backups are present and recent in the backup target.
6. Scrape `/metrics` (set `MUNGIL_METRICS_TOKEN` and send a bearer token):

   | Alert | Query |
   |---|---|
   | Error rate | `sum(rate(mungil_http_requests_total{status=~"5.."}[5m])) > 0` |
   | Latency | `histogram_quantile(0.95, sum by (le) (rate(mungil_http_request_duration_ms_bucket[5m]))) > 200` |
   | Rule denials | `sum(rate(mungil_rule_denials_total[5m])) > 1` |
   | Auth failures | `sum(rate(mungil_auth_failures_total[5m])) > 5` |
   | Disk headroom | `mungil_db_size_bytes + mungil_db_wal_size_bytes` growing without bound |
   | Saturation | `mungil_http_requests_total{status="503"}` increasing |

---

## Backups

Two mechanisms, use at least one:

### Snapshot CLI (built in)

```bash
npm run backup -- /var/backups/mungilbase          # timestamped file in the dir
npm run backup -- /var/backups/mungilbase/x.db     # exact path
npm run backup -- /var/backups/mungilbase /srv/mungilbase/mungil.config.json
```

This uses SQLite's online backup API and verifies `PRAGMA integrity_check`
and `PRAGMA foreign_key_check` immediately. It is safe while the server runs.

Cron example (every 30 minutes):

```cron
*/30 * * * * cd /srv/mungilbase && npm run backup -- /var/backups/mungilbase >> /var/log/mungilbase-backup.log 2>&1
```

Copy snapshots off the host. A backup on the same disk is a RAID, not a backup.

Retention: delete old snapshots on a schedule you can defend (e.g. 48 hourly,
14 daily, 8 weekly). Nothing prunes them automatically.

### Litestream (continuous)

`litestream.yml` and the `backup` profile in `docker-compose.yml` replicate the
WAL to S3-compatible storage. Restore:

```bash
docker compose run --rm litestream restore \
  -config /etc/litestream.yml \
  -o /data/restored.db /data/mungil.db
```

Restore to a new file, verify it, then swap. Never restore over the live file
while the app is running.

### Verify the mechanism itself

```bash
bash scripts/restore-drill.sh
```

CI runs this on every push. It creates a database, seeds rows, takes an online
backup, checks integrity, confirms the source still accepts writes, restores
the snapshot, re-runs schema sync, and compares row contents. If you change
anything under `src/db`, this must stay green.

---

## Restore procedure (snapshot)

1. **Stop the app.** `systemctl stop mungilbase` or `docker compose stop`.
2. **Keep the current file.** `mv /data/mungil.db /data/mungil.db.broken-$(date +%s)`
   (and move `-wal`/`-shm` if present).
3. **Verify the snapshot before using it:**

   ```bash
   node -e '
   const D=require("better-sqlite3");
   const db=new D(process.argv[1],{readonly:true});
   console.log(db.prepare("PRAGMA integrity_check").get());
   console.log(db.prepare("PRAGMA foreign_key_check").all());
   db.close();
   ' /var/backups/mungilbase/mungil-....db
   ```

   `integrity_check` must print `ok` and `foreign_key_check` must print `[]`.
4. **Copy it into place** and fix ownership to the app user.
5. **Run migrations/schema sync:** `npm run migrate -- ./mungil.config.json`
   (or let boot do it).
6. **Start the app**, then verify:
   - `GET /health` → 200
   - `GET /api/v1/openapi.json` → 200
   - authenticated `GET /api/v1/auth/me`
   - one read and one write against a real table
7. **Record the incident**: time of loss, RPO gap, snapshot used, rows lost.

If the snapshot fails integrity or foreign-key checks, try the next older one.
Do not "repair" a production database with `PRAGMA writable_schema`.

---

## Upgrades

1. Snapshot first: `npm run backup -- /var/backups/mungilbase`.
2. Pull the release, `npm ci`, `npm run build`.
3. `npm run migrate -- ./mungil.config.json` (checksummed migrations + additive
   schema sync). Anything destructive fails here, before the app starts.
4. Restart, then run the same smoke checks as a restore.
5. Keep the previous image tag until the next successful backup.

Rollback:

- **Code only:** redeploy the previous image tag. Migrations are forward-only.
- **Schema changed destructively:** you cannot roll back code safely. Restore
  the pre-upgrade snapshot instead, which discards writes after the snapshot.

Schema sync in v0.1 is additive: create table, add index, add nullable/defaulted
column. Renames, drops and type changes require a hand-written migration and a
planned restore path.

---

## Incidents

### Login brute force / credential stuffing

1. Look at recent failures:

   ```sql
   SELECT created_at, event, code, user_id
   FROM _mungil_audit
   WHERE code IN ('unauthorized', 'rate_limited')
   ORDER BY id DESC LIMIT 100;
   ```

2. The built-in throttle already blocks 5 failures/15 min per account and
   30/10 min per IP (defaults). For a sustained attack, block the source at the
   reverse proxy.
3. If an account is compromised: `npm run user:passwd -- user@example.com`
   (with `MUNGIL_USER_PASSWORD` set). This changes the password **and revokes
   every session for that account** in one transaction.

### Lost password / locked out

Self-service reset needs `email` config, `auth.passwordReset.enabled` (default
true), and a link target (`appUrl` or `auth.passwordReset.resetUrl`). The user
calls:

```bash
curl -X POST https://api.example.com/api/v1/auth/request-password-reset \
  -H 'content-type: application/json' -d '{"email":"user@example.com"}'
```

The answer is always `202`, whether or not the account exists. Reset tokens are
hashed, single-use and expire after 30 minutes; completing a reset revokes every
session for that account. Throttles: 3 requests/hour per address, 15/hour per
IP by default.

If email is not configured, or mail delivery is broken, the operator path is:

```bash
MUNGIL_USER_PASSWORD='new long password' npm run user:passwd -- user@example.com
```

SMTP settings live in `email`; the password comes from the environment variable
named by `email.smtp.passwordEnv` (default `MUNGIL_SMTP_PASSWORD`). The `log`
provider is refused when `NODE_ENV=production`, because it would write reset
links into the log stream.

### Email verification

Enable with `auth.emailVerification.enabled: true`. Registration then sends a
link; `required: true` rejects logins with `403 email_not_verified` until the
address is confirmed. Tokens are hashed, single-use and expire after 24 hours.
`resend-verification` requires a session and is throttled.

Accounts created with `npm run user:create` are verified by default. To audit
unverified accounts:

```sql
SELECT "email", "created_at" FROM "_mungil_auth_users" WHERE "email_verified" = 0;
```

### Suspected stolen session token

`user:passwd` revokes all sessions for the account. To revoke without changing
the password, run this in a maintenance window (or via `sqlite3`):

```sql
UPDATE _mungil_auth_sessions
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE user_id = '<id>' AND revoked_at IS NULL;

DELETE FROM _mungil_auth_tokens
WHERE session_id IN (SELECT id FROM _mungil_auth_sessions WHERE user_id = '<id>');
```

Access tokens are looked up per request, so revocation is immediate for new
requests. A request already in flight may still complete.

### Error tracking

Set `MUNGIL_SENTRY_DSN` to a Sentry (or Sentry-compatible) DSN. The app posts
unhandled exceptions and uncaught process errors with their request id; there is
no SDK and no retry queue. Reporting failures are silent by design.

Logs remain the source of truth. The event payload includes the error message,
request context and stack trace — review your data-retention policy before
pointing this at a third party.

### Database locked / WAL keeps growing

- A second process may hold the write lock. Confirm only one app process is
  using the file.
- The app sets `busy_timeout = 5000`. Persistent `SQLITE_BUSY` means a long
  transaction or an external writer.
- After stopping all writers: `PRAGMA wal_checkpoint(TRUNCATE);` then check
  that `-wal` shrank. Never delete `-wal` manually while the app runs.

### Disk full

SQLite needs free space for the WAL and for the largest write. Free space,
then restart; check `integrity_check` afterwards. Restore the newest verified
snapshot if the file is damaged.

### Audit log growth

Nothing rotates `_mungil_audit`. Decide a retention window and export before
deleting, e.g.:

```sql
DELETE FROM _mungil_audit WHERE created_at < datetime('now', '-90 days');
```

Deleting audit rows is an operator decision with compliance consequences; the
application itself never does it.

---

## Files

Uploaded files live outside SQLite in `storage.local.dir` (default
`./data/files`). They are **not** included in `npm run backup` or Litestream.

- Back the directory up separately (filesystem snapshot or `rsync`). If you need
  DB and files consistent, pause writes, snapshot the DB, then sync the files.
- Deleting a row does not delete its files. Keys are
  `<table>/<id-hash>/<field>/<uuid>.<ext>`; find orphans by listing keys and
  checking the corresponding rows, or prune by age.
- Per-field limits are enforced (`maxBytes`, `allowedTypes`). Content type is
  taken from the multipart header; there is no magic-byte sniffing or malware
  scan yet.
- Responses are served inline with a sandboxing CSP and `nosniff`, so an SVG
  upload cannot run script on the API origin.
- Disk usage is not in `/metrics`; monitor the volume with the system tooling.

## Load shedding and capacity

`server.maxConcurrency` (default 64) caps in-flight requests. Beyond that the
app returns `503 overloaded` with `Retry-After` instead of queueing. On a single
SQLite writer, queueing converts overload into unbounded latency; shedding keeps
failures cheap.

- A rising `mungil_http_requests_total{status="503"}` means the process is
  saturated. Find the slow route first; do not raise the cap on a hunch.
- Handler execution is not preempted. A slow query holds a slot until it
  returns. `busy_timeout` bounds lock waits, not query time.
- Password hashing costs ~40–60 ms each. At the default cap, a login flood can
  occupy every slot; lower `maxConcurrency` if logins dominate traffic.

## Performance baseline

Measured on a 20,000-row table, single Node 22 process, SQLite on local NTFS,
mixed workload (`/health`, list with `limit=20`, filtered list sorted by
`created_at`). Values are from `npm run bench`:

| Concurrency | Requests | Throughput | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| 16 | 9,347 | 934 req/s | 15 ms | 29 ms | 42 ms | 0 |
| 64 | 10,556 | 1,048 req/s | 57 ms | 84 ms | 113 ms | 0 |

Server-side request durations logged by the app were ~0.6–0.8 ms; the rest is
loopback and scheduling overhead. Treat these as a **relative** baseline, not a
capacity plan: re-run on the target host with a realistic table count and row
size before sizing anything.

```bash
npm run bench -- --url http://127.0.0.1:8787 --concurrency 32 --seconds 15
```

For a capacity test, seed a table without foreign keys and run k6:

```bash
npx tsx scripts/seed.ts --config ./mungil.config.json --table posts --rows 100000
BASE_URL=http://127.0.0.1:8787 RATE=200 DURATION=60s k6 run scripts/loadtest.k6.js
```

Indexes created automatically: `id` (primary key), unique fields, foreign-key
columns, and `created_at` for default ordering. If a filter is hot, add it to
the table's `indexes` config and rerun `npm run migrate`; composite indexes are
written as arrays. Removing an index from the config is refused at startup
(like removing a column), so dropping one requires an explicit migration.

---

## Roles

```bash
npm run user:role -- user@example.com admin
npm run user:role -- user@example.com user
```

The change is effective on the next request; existing tokens pick up the new
role because it is read from the database, not embedded in the token.

Promotion alone does **not** bypass table rules. If your admin UI needs to see
and edit every row, set `auth.adminBypassRules: true` and understand the
trade-off: any admin token can then read and write everything, and admin writes
are not yet separately audited.

## Admin panel

Reachable at `https://your-host/admin`. Only `admin` accounts can sign in; the
panel session is a separate HttpOnly cookie valid for 8 hours
(`auth.adminSessionTtlSeconds`) and every form has a CSRF token.

- The panel uses the same ruled CRUD layer as the API. If an admin sees nothing
  in a table, the table rules are hiding rows — enable `adminBypassRules` only
  if that is the intended trade-off.
- Set `appUrl` to your HTTPS origin so the admin and CSRF cookies get the
  `Secure` flag.
- Admin activity is audited: `auth.admin_login`, `auth.admin_logout`,
  `admin.create`, `admin.update`, `admin.delete`.
- Logging out revokes the panel session. Changing the account role takes effect
  on the next request; demoting an admin invalidates the panel session on its
  next use.

## Security operations

- Tokens are opaque and stored hashed; there is no signing key to rotate.
- `MUNGIL_TRUST_PROXY=1` only when a trusted proxy sets `X-Forwarded-For`.
  Otherwise clients can choose their own rate-limit bucket.
- Database backups contain password hashes and session hashes. Encrypt the
  backup target and restrict access.
- `GET /api/v1/openapi.json` is public by design; it describes the API, not
  your data.

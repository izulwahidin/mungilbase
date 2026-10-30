# ADR 0001: Node + SQLite, single node

- **Status:** accepted
- **Date:** 2026-10-29
- **Context:** Rebuild of a teenybase-style backend, self-hosted, solo developer,
  three months to a credible v0.1.

## Decision

Target **Node 22 + SQLite (better-sqlite3, WAL) + Hono**, published as an npm
package with an `npx` CLI. One process per deployment. Litestream is optional
for continuous backup.

## Why

| Requirement | Node + SQLite | Cloudflare Workers + D1 |
|---|---|---|
| Real interactive transactions | Yes | No (batch only) |
| Session/refresh correctness | Straightforward | KV is eventually consistent; needs Durable Objects |
| Local dev = production runtime | Yes | Emulated (`workerd`) |
| Data portability / backup | One file, testable restore | Export API, 10 GB cap |
| Ops burden | Patching + TLS | Near zero |
| Cost | $5–12/mo VPS | Free tier, then usage |

For a solo builder whose scarce resource is correctness time, the extra ops work
is smaller than the correctness work D1's constraints demand. The 10 GB and
transaction constraints are acceptable only if the product is small; SQLite
removes that cliff.

## Consequences

- **Positive:** transactions, savepoints, synchronous auth flows, filesystem
  access for uploads and backups, trivial debugging.
- **Negative:** single region, single writer, the operator owns patching and
  TLS, and scale-out requires an external read path.
- **Mitigation:** documented runbook, Litestream, health checks, and a
  `StorageAdapter` seam so another engine can be added later without changing
  the query layer.

## Alternatives rejected

- **Postgres:** correct, but a second service to operate and back up; the target
  audience is one small app per box.
- **libSQL/Turso:** still viable later; one more network dependency today.
- **Workers/D1:** see table.
- **PocketBase itself:** no typed config, no rules-as-code, not our scope.

## Revisit when

- A deployment needs >1 writer, multi-region reads, or >10 GB.
- Hosting becomes managed (multi-tenant), which changes the threat model and
  likely forces Postgres or per-tenant SQLite.

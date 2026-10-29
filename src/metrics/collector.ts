import { statSync } from 'node:fs'
import type { Db } from '../db/connect.js'

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000]

interface RouteMetrics {
  count: number
  sumMs: number
  /** Cumulative: bucket[i] counts every request <= BUCKETS_MS[i]. */
  buckets: number[]
  statuses: Map<number, number>
}

export interface RenderInput {
  db?: Db
  dbFile?: string
  version: string
}

function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function metric(name: string, type: 'counter' | 'gauge' | 'histogram', help: string, body: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...body]
}

/**
 * Process-local metrics in Prometheus text format.
 *
 * Counters reset on restart, which is expected: Prometheus handles resets.
 * Route labels use the matched Hono pattern (`/api/v1/:table`), never the raw
 * path, so cardinality stays bounded by the config.
 */
export class MetricsCollector {
  private readonly routes = new Map<string, RouteMetrics>()
  private readonly authFailures = new Map<string, number>()
  private readonly ruleDenials = new Map<string, number>()
  private readonly startedAt = Date.now()

  observe(method: string, route: string, status: number, durationMs: number): void {
    const key = `${method} ${route}`
    let entry = this.routes.get(key)
    if (!entry) {
      entry = { count: 0, sumMs: 0, buckets: BUCKETS_MS.map(() => 0), statuses: new Map() }
      this.routes.set(key, entry)
    }

    entry.count += 1
    entry.sumMs += durationMs
    for (let index = 0; index < BUCKETS_MS.length; index += 1) {
      if (durationMs <= BUCKETS_MS[index]!) entry.buckets[index] = (entry.buckets[index] ?? 0) + 1
    }
    entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1)
  }

  authFailure(reason: 'unauthorized' | 'rate_limited'): void {
    this.authFailures.set(reason, (this.authFailures.get(reason) ?? 0) + 1)
  }

  ruleDenial(table: string, operation: string): void {
    const key = `${table}|${operation}`
    this.ruleDenials.set(key, (this.ruleDenials.get(key) ?? 0) + 1)
  }

  render(input: RenderInput): string {
    const lines: string[] = []

    const requestLines: string[] = []
    const durationLines: string[] = []

    for (const [key, entry] of this.routes) {
      const [method = '', ...routeParts] = key.split(' ')
      const route = routeParts.join(' ')

      for (const [status, count] of entry.statuses) {
        requestLines.push(
          `mungil_http_requests_total{method="${label(method)}",route="${label(route)}",status="${status}"} ${count}`,
        )
      }

      for (let index = 0; index < BUCKETS_MS.length; index += 1) {
        durationLines.push(
          `mungil_http_request_duration_ms_bucket{method="${label(method)}",route="${label(route)}",le="${BUCKETS_MS[index]}"} ${entry.buckets[index] ?? 0}`,
        )
      }
      durationLines.push(
        `mungil_http_request_duration_ms_bucket{method="${label(method)}",route="${label(route)}",le="+Inf"} ${entry.count}`,
      )
      durationLines.push(
        `mungil_http_request_duration_ms_sum{method="${label(method)}",route="${label(route)}"} ${entry.sumMs.toFixed(2)}`,
      )
      durationLines.push(
        `mungil_http_request_duration_ms_count{method="${label(method)}",route="${label(route)}"} ${entry.count}`,
      )
    }

    lines.push(
      ...metric(
        'mungil_http_requests_total',
        'counter',
        'HTTP requests by matched route and status.',
        requestLines,
      ),
    )
    lines.push(
      ...metric(
        'mungil_http_request_duration_ms',
        'histogram',
        'HTTP request duration in milliseconds.',
        durationLines,
      ),
    )

    const authLines = [...this.authFailures].map(
      ([reason, count]) => `mungil_auth_failures_total{reason="${label(reason)}"} ${count}`,
    )
    lines.push(
      ...metric('mungil_auth_failures_total', 'counter', 'Authentication failures by reason.', authLines),
    )

    const denialLines = [...this.ruleDenials].map(([key, count]) => {
      const [table = 'unknown', operation = 'unknown'] = key.split('|')
      return `mungil_rule_denials_total{table="${label(table)}",operation="${label(operation)}"} ${count}`
    })
    lines.push(
      ...metric('mungil_rule_denials_total', 'counter', 'Rule denials by table and operation.', denialLines),
    )

    lines.push(
      ...metric('mungil_process_uptime_seconds', 'gauge', 'Process uptime in seconds.', [
        `mungil_process_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`,
      ]),
      ...metric('mungil_process_resident_memory_bytes', 'gauge', 'Resident memory in bytes.', [
        `mungil_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      ]),
    )

    if (input.dbFile && input.dbFile !== ':memory:') {
      lines.push(
        ...metric('mungil_db_size_bytes', 'gauge', 'Main database file size in bytes.', [
          `mungil_db_size_bytes ${fileSize(input.dbFile)}`,
        ]),
        ...metric('mungil_db_wal_size_bytes', 'gauge', 'SQLite WAL size in bytes.', [
          `mungil_db_wal_size_bytes ${fileSize(`${input.dbFile}-wal`)}`,
        ]),
      )
    }

    if (input.db) {
      try {
        const row = input.db
          .prepare(
            `SELECT COUNT(*) AS "count" FROM "_mungil_auth_sessions"
             WHERE "revoked_at" IS NULL AND "expires_at" > ?`,
          )
          .get(new Date().toISOString()) as { count: number }
        lines.push(
          ...metric('mungil_active_sessions', 'gauge', 'Unrevoked, unexpired sessions.', [
            `mungil_active_sessions ${row.count}`,
          ]),
        )
      } catch {
        // Auth tables may not exist on a deployment without auth.
      }
    }

    lines.push(
      ...metric('mungil_build_info', 'gauge', 'Build information.', [
        `mungil_build_info{version="${label(input.version)}"} 1`,
      ]),
    )

    return `${lines.join('\n')}\n`
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

import { randomUUID } from 'node:crypto'

export interface SentryTarget {
  endpoint: string
  publicKey: string
  projectId: string
}

/**
 * Parses a Sentry DSN into the store endpoint.
 *
 * Supports SaaS and self-hosted DSNs with a path prefix:
 *   https://key@o0.ingest.sentry.io/42
 *   https://key@sentry.example.com/sentry/42
 */
export function parseDsn(dsn: string): SentryTarget | null {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }

  if (!url.username) return null
  const segments = url.pathname.split('/').filter(Boolean)
  const projectId = segments.pop()
  if (!projectId || !/^[0-9]+$/.test(projectId)) return null

  const prefix = segments.length ? `/${segments.join('/')}` : ''
  return {
    endpoint: `${url.origin}${prefix}/api/${projectId}/store/`,
    publicKey: url.username,
    projectId,
  }
}

export interface ErrorReporterOptions {
  dsn?: string
  environment?: string
  release?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void

/**
 * Minimal Sentry-compatible reporter: no SDK, no global handlers, no retries.
 *
 * Reporting must never take the app down. Every network failure is swallowed;
 * the local structured log remains the source of truth.
 */
export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const target = options.dsn ? parseDsn(options.dsn) : null
  if (!target) return () => {}

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000

  return (error, context = {}) => {
    const timestamp = Date.now() / 1000
    const message = error instanceof Error ? error.message : String(error)

    const event = {
      event_id: randomUUID().replaceAll('-', ''),
      timestamp,
      platform: 'node',
      level: 'error',
      environment: options.environment,
      release: options.release,
      server_name: 'mungilbase',
      message: { formatted: message },
      exception: {
        values: [
          {
            type: error instanceof Error ? error.name : 'Error',
            value: message,
            stacktrace: error instanceof Error && error.stack ? { frames: [] } : undefined,
          },
        ],
      },
      extra: context,
    }

    const auth =
      `Sentry sentry_version=7, sentry_client=mungilbase/0.1.0, ` +
      `sentry_key=${target.publicKey}, sentry_timestamp=${Math.floor(timestamp)}`

    void fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': auth,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      // Deliberately silent: a failing reporter must not become an incident.
    })
  }
}

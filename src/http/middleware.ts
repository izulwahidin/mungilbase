import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './app.js'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/

/**
 * Trusts a caller-supplied request id only if it looks like one, otherwise
 * generates a fresh uuid. Request ids end up in logs, so they must not be
 * attacker-controlled free text.
 */
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const provided = c.req.header('x-request-id')
    const id = provided && REQUEST_ID_PATTERN.test(provided) ? provided : randomUUID()
    c.set('requestId', id)
    c.header('x-request-id', id)
    await next()
  }
}

/** One JSON line per request. Keep it boring and greppable. */
export function requestLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = performance.now()
    await next()
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'request',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      }),
    )
  }
}

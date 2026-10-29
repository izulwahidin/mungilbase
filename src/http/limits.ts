import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './app.js'
import { AppError } from './errors.js'

/**
 * Sheds load instead of queueing it.
 *
 * A bounded queue on a single SQLite writer mostly converts overload into
 * long tail latency. Returning 503 immediately keeps the failures cheap and
 * lets a proxy retry. Requests already in flight are not interrupted.
 */
export function concurrencyLimit(max: number): MiddlewareHandler<AppEnv> {
  let active = 0

  return async (_c, next) => {
    if (active >= max) {
      throw new AppError(503, 'overloaded', 'Server is at capacity, retry shortly', {
        retryAfterSeconds: 1,
      })
    }

    active += 1
    try {
      await next()
    } finally {
      active -= 1
    }
  }
}

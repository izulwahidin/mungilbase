import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './app.js'
import type { MetricsCollector } from '../metrics/collector.js'
import { AppError } from './errors.js'

/**
 * Records every request against the matched route pattern, so the metrics
 * label set is bounded by the config, not by client-supplied paths.
 */
export function metricsMiddleware(collector: MetricsCollector): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = performance.now()
    let status = 500

    try {
      await next()
      status = c.res.status
    } catch (error) {
      if (error instanceof AppError) status = error.statusCode
      throw error
    } finally {
      const route = c.req.routePath || 'unmatched'
      collector.observe(c.req.method, route, status, performance.now() - startedAt)
    }
  }
}

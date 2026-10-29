import type { Context } from 'hono'

interface NodeEnv {
  incoming?: {
    socket?: {
      remoteAddress?: string
    }
  }
}

/**
 * Best-effort client address for throttling.
 *
 * X-Forwarded-For is only trusted when MUNGIL_TRUST_PROXY=1, because otherwise
 * any client could pick its own rate-limit bucket by spoofing the header.
 */
export function clientIp(c: Context): string | null {
  if (process.env.MUNGIL_TRUST_PROXY === '1') {
    const forwarded = c.req.header('x-forwarded-for')
    const first = forwarded?.split(',')[0]?.trim()
    if (first) return first
  }

  const env = c.env as unknown as NodeEnv | undefined
  return env?.incoming?.socket?.remoteAddress ?? null
}

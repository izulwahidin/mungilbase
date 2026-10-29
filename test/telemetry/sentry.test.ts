import { describe, expect, it, vi } from 'vitest'
import { createErrorReporter, parseDsn } from '../../src/telemetry/sentry.js'

describe('parseDsn', () => {
  it('builds the store endpoint for SaaS and self-hosted DSNs', () => {
    expect(parseDsn('https://abc123@o0.ingest.sentry.io/42')).toEqual({
      endpoint: 'https://o0.ingest.sentry.io/api/42/store/',
      publicKey: 'abc123',
      projectId: '42',
    })

    expect(parseDsn('https://key@sentry.example.com/sentry/7')).toEqual({
      endpoint: 'https://sentry.example.com/sentry/api/7/store/',
      publicKey: 'key',
      projectId: '7',
    })
  })

  it('rejects malformed DSNs', () => {
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('https://example.com/42')).toBeNull()
    expect(parseDsn('https://key@example.com/not-a-project')).toBeNull()
  })
})

describe('createErrorReporter', () => {
  it('posts a Sentry-compatible event with context', () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const report = createErrorReporter({
      dsn: 'https://key@o0.ingest.sentry.io/42',
      environment: 'test',
      release: '0.1.0',
      fetchImpl: fakeFetch,
    })

    report(new Error('boom'), { requestId: 'req-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://o0.ingest.sentry.io/api/42/store/')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-sentry-auth']).toContain('sentry_key=key')

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      event_id: string
      message: { formatted: string }
      extra: Record<string, unknown>
      environment: string
    }
    expect(body.event_id).toHaveLength(32)
    expect(body.message.formatted).toBe('boom')
    expect(body.extra.requestId).toBe('req-1')
    expect(body.environment).toBe('test')
  })

  it('is a no-op without a DSN', () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch
    const report = createErrorReporter({ fetchImpl: fakeFetch })
    expect(() => report(new Error('ignored'))).not.toThrow()
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('swallows transport failures', async () => {
    const failing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const report = createErrorReporter({
      dsn: 'https://key@o0.ingest.sentry.io/42',
      fetchImpl: failing,
    })
    expect(() => report(new Error('boom'))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

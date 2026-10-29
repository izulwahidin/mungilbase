import { afterEach, describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { createApp } from '../../src/http/app.js'

const app = createApp({
  config: configSchema.parse({ tables: [] }),
  version: '9.9.9',
})

afterEach(() => {
  delete process.env.MUNGIL_METRICS_TOKEN
})

describe('/metrics', () => {
  it('serves Prometheus text with recorded requests', async () => {
    await app.request('/health')
    const response = await app.request('/metrics')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')

    const text = await response.text()
    expect(text).toContain('# TYPE mungil_http_requests_total counter')
    expect(text).toContain('route="/health"')
    expect(text).toContain('mungil_build_info{version="9.9.9"} 1')
  })

  it('requires a bearer token when MUNGIL_METRICS_TOKEN is set', async () => {
    const token = 'a'.repeat(43)
    process.env.MUNGIL_METRICS_TOKEN = token

    expect((await app.request('/metrics')).status).toBe(401)
    expect(
      (await app.request('/metrics', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401)

    const authorized = await app.request('/metrics', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)
  })
})

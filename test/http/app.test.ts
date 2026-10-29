import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { createApp } from '../../src/http/app.js'

const config = configSchema.parse({ allowedOrigins: ['https://app.example.com'] })
const app = createApp({ config, version: '9.9.9' })

describe('http app', () => {
  it('reports health without leaking details', async () => {
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.version).toBe('9.9.9')
    expect(JSON.stringify(body)).not.toContain('database')
  })

  it('reports the version', async () => {
    const response = await app.request('/version')
    expect(await response.json()).toEqual({ version: '9.9.9' })
  })

  it('returns json 404s with a request id', async () => {
    const response = await app.request('/nope')
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string; request_id: string } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.request_id).toHaveLength(36)
    expect(response.headers.get('x-request-id')).toBe(body.error.request_id)
  })

  it('echoes a well-formed caller request id', async () => {
    const response = await app.request('/version', { headers: { 'x-request-id': 'trace-abc-123' } })
    expect(response.headers.get('x-request-id')).toBe('trace-abc-123')
  })

  it('replaces a malformed caller request id', async () => {
    const response = await app.request('/version', { headers: { 'x-request-id': 'not a valid id!' } })
    expect(response.headers.get('x-request-id')).not.toBe('not a valid id!')
  })

  it('allows only configured browser origins', async () => {
    const allowed = await app.request('/api/v1/x', { headers: { Origin: 'https://app.example.com' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com')

    const denied = await app.request('/api/v1/x', { headers: { Origin: 'https://evil.example.com' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('sets baseline security headers', async () => {
    const response = await app.request('/version')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})

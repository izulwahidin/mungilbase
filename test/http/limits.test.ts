import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../../src/http/app.js'
import { AppError } from '../../src/http/errors.js'
import { concurrencyLimit } from '../../src/http/limits.js'

function slowApp(max: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', concurrencyLimit(max))
  app.get('/slow', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return c.text('ok')
  })
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json({ code: error.code }, error.statusCode)
      : c.text('unexpected', 500),
  )
  return app
}

describe('concurrencyLimit', () => {
  it('sheds requests once the cap is reached', async () => {
    const app = slowApp(1)

    const first = app.request('/slow')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await app.request('/slow')

    expect(second.status).toBe(503)
    expect(await second.json()).toEqual({ code: 'overloaded' })
    expect((await first).status).toBe(200)
  })

  it('frees capacity when a request finishes', async () => {
    const app = slowApp(1)

    expect((await app.request('/slow')).status).toBe(200)
    expect((await app.request('/slow')).status).toBe(200)
  })
})

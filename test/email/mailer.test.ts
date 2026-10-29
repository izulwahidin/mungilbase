import { afterEach, describe, expect, it, vi } from 'vitest'
import { emailConfigSchema } from '../../src/config/schema.js'
import { createMailer } from '../../src/email/mailer.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createMailer', () => {
  it('logs messages in the development provider', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = createMailer(
      emailConfigSchema.parse({ provider: 'log', from: 'noreply@example.com' }),
      {},
    )

    await mailer.send({ to: 'user@example.com', subject: 'Hello', text: 'body' })

    expect(spy).toHaveBeenCalledTimes(1)
    const line = spy.mock.calls[0]![0] as string
    expect(line).toContain('"event":"email_logged"')
    expect(line).toContain('user@example.com')
  })

  it('refuses the log provider in production', () => {
    expect(() =>
      createMailer(
        emailConfigSchema.parse({ provider: 'log', from: 'noreply@example.com' }),
        { NODE_ENV: 'production' },
      ),
    ).toThrow(/not allowed in production/)
  })

  it('requires the SMTP password from the configured environment variable', () => {
    const config = emailConfigSchema.parse({
      provider: 'smtp',
      from: 'noreply@example.com',
      smtp: { host: '127.0.0.1', user: 'mailer', passwordEnv: 'SMTP_PASS' },
    })

    expect(() => createMailer(config, {})).toThrow(/SMTP_PASS/)
    expect(() => createMailer(config, { SMTP_PASS: 'secret' })).not.toThrow()
  })

  it('supports unauthenticated SMTP relays', () => {
    const config = emailConfigSchema.parse({
      provider: 'smtp',
      from: 'noreply@example.com',
      smtp: { host: '127.0.0.1', port: 25 },
    })

    expect(() => createMailer(config, {})).not.toThrow()
  })

  it('rejects smtp without settings at config time', () => {
    expect(
      emailConfigSchema.safeParse({ provider: 'smtp', from: 'noreply@example.com' }).success,
    ).toBe(false)
  })
})

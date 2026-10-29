import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'

const baseTable = {
  name: 'posts',
  fields: [{ name: 'title', type: 'text', required: true }],
  rules: {
    list: 'true',
    view: 'true',
    create: 'auth.uid != null',
    update: 'auth.uid == owner_id',
    delete: null,
  },
}

describe('config schema', () => {
  it('fills in safe defaults', () => {
    const config = configSchema.parse({ tables: [baseTable] })
    expect(config.server).toEqual({ host: '0.0.0.0', port: 8787, maxConcurrency: 64 })
    expect(config.database).toEqual({ file: './data/mungil.db' })
    expect(config.allowedOrigins).toEqual([])
    expect(config.tables[0]!.timestamps).toBe(true)
  })

  it('requires every rule explicitly', () => {
    const withoutRules = { name: baseTable.name, fields: baseTable.fields }
    expect(configSchema.safeParse({ tables: [withoutRules] }).success).toBe(false)
  })

  it('rejects all five rules being omitted in favour of a default', () => {
    const partial = { ...baseTable, rules: { list: 'true' } }
    expect(configSchema.safeParse({ tables: [partial] }).success).toBe(false)
  })

  it('rejects duplicate tables, duplicate fields and reserved names', () => {
    expect(configSchema.safeParse({ tables: [baseTable, baseTable] }).success).toBe(false)

    const duplicateField = {
      ...baseTable,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'title', type: 'text' },
      ],
    }
    expect(configSchema.safeParse({ tables: [duplicateField] }).success).toBe(false)

    const reserved = { ...baseTable, fields: [{ name: 'id', type: 'text' }] }
    expect(configSchema.safeParse({ tables: [reserved] }).success).toBe(false)
  })

  it('rejects references to unknown tables and columns', () => {
    const unknownTable = {
      ...baseTable,
      fields: [{ name: 'author_id', type: 'text', references: { table: 'ghosts', column: 'id' } }],
    }
    expect(configSchema.safeParse({ tables: [unknownTable] }).success).toBe(false)

    const users = {
      name: 'users',
      fields: [{ name: 'email', type: 'text' }],
      rules: { list: null, view: null, create: null, update: null, delete: null },
    }
    const unknownColumn = {
      ...baseTable,
      fields: [{ name: 'author_id', type: 'text', references: { table: 'users', column: 'nope' } }],
    }
    expect(configSchema.safeParse({ tables: [unknownColumn, users] }).success).toBe(false)
  })

  it('accepts references to declared columns and to the implicit id', () => {
    const users = {
      name: 'users',
      fields: [{ name: 'email', type: 'text' }],
      rules: { list: null, view: null, create: null, update: null, delete: null },
    }
    const byEmail = { ...baseTable, fields: [{ name: 'author_id', type: 'text', references: { table: 'users', column: 'email' } }] }
    expect(configSchema.safeParse({ tables: [byEmail, users] }).success).toBe(true)

    const byId = { ...baseTable, fields: [{ name: 'author_id', type: 'text', references: { table: 'users', column: 'id' } }] }
    expect(configSchema.safeParse({ tables: [byId, users] }).success).toBe(true)
  })

  it('validates email and password reset settings', () => {
    const withEmail = {
      appUrl: 'http://localhost:8787',
      auth: { allowSignup: true },
      email: { provider: 'log', from: 'noreply@example.com' },
      tables: [],
    }

    const parsed = configSchema.parse(withEmail)
    expect(parsed.auth?.passwordReset).toEqual({
      enabled: true,
      tokenTtlSeconds: 1_800,
      maxRequestsPerHour: 3,
    })

    // Reset needs a link target.
    expect(
      configSchema.safeParse({ ...withEmail, appUrl: undefined, auth: { allowSignup: true } }).success,
    ).toBe(false)
    expect(
      configSchema.safeParse({
        ...withEmail,
        appUrl: undefined,
        auth: { allowSignup: true, passwordReset: { resetUrl: 'https://app.example.com/reset' } },
      }).success,
    ).toBe(true)

    // SMTP provider requires settings.
    expect(
      configSchema.safeParse({
        ...withEmail,
        email: { provider: 'smtp', from: 'noreply@example.com' },
      }).success,
    ).toBe(false)
  })

  it('validates email verification settings', () => {
    const base = {
      appUrl: 'http://localhost:8787',
      auth: { allowSignup: true, emailVerification: { enabled: true } },
      email: { provider: 'log', from: 'noreply@example.com' },
      tables: [],
    }

    expect(configSchema.parse(base).auth?.emailVerification).toEqual({
      enabled: true,
      required: false,
      tokenTtlSeconds: 86_400,
      maxRequestsPerHour: 3,
    })

    // Requires an email provider and a link target.
    expect(
      configSchema.safeParse({
        appUrl: 'http://localhost:8787',
        auth: { allowSignup: true, emailVerification: { enabled: true } },
        tables: [],
      }).success,
    ).toBe(false)

    expect(
      configSchema.safeParse({
        auth: { allowSignup: true, emailVerification: { enabled: true } },
        email: { provider: 'log', from: 'noreply@example.com' },
        tables: [],
      }).success,
    ).toBe(false)

    expect(
      configSchema.safeParse({
        ...base,
        appUrl: undefined,
        auth: {
          allowSignup: true,
          passwordReset: { enabled: false },
          emailVerification: { enabled: true, verifyUrl: 'https://app.example.com/verify' },
        },
      }).success,
    ).toBe(true)
  })

  it('validates file fields and storage settings', () => {
    const parsed = configSchema.parse({
      tables: [{ ...baseTable, fields: [{ name: 'upload', type: 'file' }] }],
    })
    expect(parsed.tables[0]!.fields[0]).toMatchObject({
      type: 'file',
      maxBytes: 5_000_000,
      allowedTypes: ['image/'],
    })
    expect(parsed.storage).toBeUndefined()

    const withStorage = configSchema.parse({
      storage: { local: { dir: '/srv/files' } },
      tables: [],
    })
    expect(withStorage.storage).toEqual({ provider: 'local', local: { dir: '/srv/files' } })

    expect(
      configSchema.safeParse({
        tables: [{ ...baseTable, fields: [{ name: 'upload', type: 'file', allowedTypes: [] }] }],
      }).success,
    ).toBe(true)
  })

  it('accepts configured indexes and rejects bad ones', () => {
    expect(
      configSchema.safeParse({
        tables: [{ ...baseTable, indexes: ['title', ['title', 'created_at']] }],
      }).success,
    ).toBe(true)

    expect(
      configSchema.safeParse({ tables: [{ ...baseTable, indexes: ['missing'] }] }).success,
    ).toBe(false)

    expect(
      configSchema.safeParse({ tables: [{ ...baseTable, indexes: [['title', 'title']] }] }).success,
    ).toBe(false)
  })
})

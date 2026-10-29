import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { buildOpenApi } from '../../src/openapi/spec.js'

const rules = { list: 'true', view: 'true', create: null, update: null, delete: null }

const withAuth = configSchema.parse({
  appUrl: 'https://api.example.com',
  auth: { allowSignup: false },
  tables: [
    {
      name: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
        { name: 'views', type: 'integer', default: 0 },
        { name: 'rating', type: 'real' },
        { name: 'meta', type: 'json' },
        { name: 'published_at', type: 'date' },
      ],
      rules: { ...rules, create: 'auth.uid != null' },
    },
  ],
})

const withoutAuth = configSchema.parse({ tables: [{ name: 'notes', fields: [{ name: 'text', type: 'text' }], rules }] })

// The generated document is dynamic; index it loosely in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

describe('buildOpenApi', () => {
  const spec = buildOpenApi(withAuth, '1.2.3') as Loose

  it('emits an OpenAPI 3.1 document with server metadata', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('MungilBase')
    expect(spec.info.version).toBe('1.2.3')
    expect(spec.servers).toEqual([{ url: 'https://api.example.com' }])
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http')
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })

  it('describes table routes and schemas from the config', () => {
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/posts',
        '/api/v1/posts/{id}',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/auth/me',
        '/api/v1/auth/register',
      ]),
    )

    const read = spec.components.schemas.postsRead
    expect(read.required).toEqual(
      expect.arrayContaining(['id', 'title', 'created_at', 'updated_at']),
    )
    expect(read.properties.body.anyOf).toEqual([{ type: 'string' }, { type: 'null' }])
    expect(read.properties.published.anyOf).toEqual([{ type: 'boolean' }, { type: 'null' }])
    expect(read.properties.views.anyOf).toEqual([{ type: 'integer' }, { type: 'null' }])
    expect(read.properties.rating.anyOf).toEqual([{ type: 'number' }, { type: 'null' }])
    expect(read.properties.meta.anyOf).toEqual([{}, { type: 'null' }])
    expect(read.properties.published_at.anyOf).toEqual([{ type: 'string' }, { type: 'null' }])
  })

  it('marks defaulted fields as optional on create', () => {
    const create = spec.components.schemas.postsCreate
    expect(create.required).toEqual(['title'])
    expect(create.additionalProperties).toBe(false)

    const update = spec.components.schemas.postsUpdate
    expect(update.minProperties).toBe(1)
    expect(update.required).toBeUndefined()
  })

  it('documents denial semantics and query parameters', () => {
    const collection = spec.paths['/api/v1/posts']
    expect(collection.post.responses[403]).toBeDefined()
    expect(collection.post.responses[409]).toBeDefined()
    expect(collection.get.parameters.map((parameter: Loose) => parameter.name)).toEqual([
      'filter',
      'sort',
      'limit',
      'offset',
    ])

    const item = spec.paths['/api/v1/posts/{id}']
    expect(item.get.responses[404]).toBeDefined()
    expect(item.patch.responses[403]).toBeDefined()
    expect(item.delete.responses[403]).toBeDefined()
  })

  it('omits auth paths when auth is disabled', () => {
    const closed = buildOpenApi(withoutAuth, '1.0.0') as Loose
    expect(Object.keys(closed.paths).some((path: string) => path.startsWith('/api/v1/auth'))).toBe(false)
    expect(closed.components.schemas.AuthSession).toBeUndefined()
    expect(closed.servers).toBeUndefined()
  })

  it('round-trips through JSON without undefined values', () => {
    const encoded = JSON.stringify(spec)
    expect(encoded).not.toContain('undefined')
    expect(JSON.parse(encoded)).toEqual(spec)
  })
})

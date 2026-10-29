import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { configSchema } from '../../src/config/schema.js'
import { generateSdk, sdkMethodNames } from '../../src/sdk/generate.js'

const config = configSchema.parse({
  appUrl: 'http://localhost:8787',
  auth: { allowSignup: true },
  email: { provider: 'log', from: 'noreply@example.com' },
  tables: [
    {
      name: 'post_comments',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
        { name: 'score', type: 'integer' },
        { name: 'meta', type: 'json' },
        { name: 'cover', type: 'file', allowedTypes: ['image/'] },
        { name: 'when', type: 'date' },
      ],
      rules: { list: 'true', view: 'true', create: 'true', update: 'true', delete: 'true' },
    },
  ],
})

const code = generateSdk(config, { version: '9.9.9' })

describe('generateSdk', () => {
  it('emits read, create and update interfaces with accurate nullability', () => {
    expect(code).toContain('export interface PostComments {')
    expect(code).toContain('title: string')
    expect(code).toContain('body: string | null')
    expect(code).toContain('score: number | null')
    expect(code).toContain('meta: JsonValue | null')
    expect(code).toContain('cover: string | null')
    expect(code).toContain('when: string | null')
    expect(code).toContain('created_at: string')

    expect(code).toContain('export interface PostCommentsCreate {')
    expect(code).toContain('title: string')
    expect(code).toContain('published?: boolean | null')
    expect(code).toContain('cover?: string | null')

    expect(code).toContain('export interface PostCommentsUpdate {')
    expect(code).toContain('title?: string | null')
  })

  it('emits table, file and auth methods', () => {
    const methods = sdkMethodNames(config)
    expect(methods).toEqual(
      expect.arrayContaining([
        'listPostComments',
        'getPostComments',
        'createPostComments',
        'updatePostComments',
        'deletePostComments',
        'uploadPostCommentsCover',
        'downloadPostCommentsCover',
      ]),
    )

    expect(code).toContain('async login(email: string, password: string): Promise<AuthSession>')
    expect(code).toContain('async refresh(): Promise<AuthSession>')
    expect(code).toContain("role: 'user' | 'admin'")
    expect(code).toContain('class MungilApiError')
    expect(code).toContain('MungilBase 9.9.9')
  })

  it('produces syntactically valid TypeScript', () => {
    const result = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    })
    expect(result.diagnostics ?? []).toHaveLength(0)
  })
})

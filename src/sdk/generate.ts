import type { FieldConfig, MungilConfig, TableConfig } from '../config/schema.js'
import { VERSION } from '../version.js'

function pascal(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function tsType(field: FieldConfig): string {
  switch (field.type) {
    case 'text':
    case 'date':
    case 'file':
      return 'string'
    case 'integer':
    case 'real':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'json':
      return 'JsonValue'
  }
}

function readField(field: FieldConfig): string {
  return `${field.name}: ${tsType(field)}${field.required ? '' : ' | null'}`
}

function createField(field: FieldConfig): string {
  const required = field.required && field.default === undefined
  return required
    ? `${field.name}: ${tsType(field)}`
    : `${field.name}?: ${tsType(field)} | null`
}

function updateField(field: FieldConfig): string {
  return `${field.name}?: ${tsType(field)} | null`
}

function tableInterfaces(table: TableConfig): string[] {
  const name = pascal(table.name)
  const read = [`  id: string`, ...table.fields.map((field) => `  ${readField(field)}`)]
  if (table.timestamps) read.push('  created_at: string', '  updated_at: string')

  return [
    `export interface ${name} {\n${read.join('\n')}\n}`,
    `export interface ${name}Create {\n${table.fields.map((field) => `  ${createField(field)}`).join('\n')}\n}`,
    `export interface ${name}Update {\n${table.fields.map((field) => `  ${updateField(field)}`).join('\n')}\n}`,
  ]
}

function tableMethods(table: TableConfig): string[] {
  const name = pascal(table.name)
  const path = `/api/v1/${table.name}`
  const methods: string[] = [
    `  async list${name}(params: ListParams = {}): Promise<{ items: ${name}[]; limit: number; offset: number }> {
    const query = new URLSearchParams()
    if (params.filter) query.set('filter', params.filter)
    if (params.sort) query.set('sort', params.sort)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.offset !== undefined) query.set('offset', String(params.offset))
    const suffix = query.toString()
    return this.request(\`${path}\${suffix ? '?' + suffix : ''}\`)
  }`,
    `  async get${name}(id: string): Promise<${name}> {
    return this.request(\`${path}/\${encodeURIComponent(id)}\`)
  }`,
    `  async create${name}(data: ${name}Create): Promise<${name}> {
    return this.request(\`${path}\`, { method: 'POST', body: JSON.stringify(data) })
  }`,
    `  async update${name}(id: string, data: ${name}Update): Promise<${name}> {
    return this.request(\`${path}/\${encodeURIComponent(id)}\`, { method: 'PATCH', body: JSON.stringify(data) })
  }`,
    `  async delete${name}(id: string): Promise<${name}> {
    return this.request(\`${path}/\${encodeURIComponent(id)}\`, { method: 'DELETE' })
  }`,
  ]

  for (const field of table.fields.filter((candidate) => candidate.type === 'file')) {
    const fieldName = pascal(field.name)
    methods.push(
      `  async upload${name}${fieldName}(id: string, file: Blob, filename = 'file'): Promise<{ field: string; key: string; row: ${name} }> {
    const form = new FormData()
    form.append('file', file, filename)
    return this.request(\`${path}/\${encodeURIComponent(id)}/files/${field.name}\`, { method: 'POST', body: form })
  }`,
      `  async download${name}${fieldName}(id: string): Promise<Response> {
    return this.raw(\`${path}/\${encodeURIComponent(id)}/files/${field.name}\`)
  }`,
    )
  }

  return methods
}

function authTypes(): string[] {
  return [
    `export interface AuthUser {
  id: string
  email: string
  role: 'user' | 'admin'
  emailVerified: boolean
}`,
    `export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
}`,
    `export interface AuthSession {
  user: AuthUser
  tokens: TokenPair
}`,
  ]
}

function authMethods(): string[] {
  return [
    `  async login(email: string, password: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.setTokens(session.tokens.accessToken, session.tokens.refreshToken)
    return session
  }`,
    `  async register(email: string, password: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.setTokens(session.tokens.accessToken, session.tokens.refreshToken)
    return session
  }`,
    `  async refresh(): Promise<AuthSession> {
    if (!this.refreshToken) throw new Error('No refresh token set')
    const session = await this.request<AuthSession>('/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    })
    this.setTokens(session.tokens.accessToken, session.tokens.refreshToken)
    return session
  }`,
    `  async logout(): Promise<void> {
    try {
      await this.request<undefined>('/api/v1/auth/logout', { method: 'POST' })
    } finally {
      this.setTokens(null, null)
    }
  }`,
    `  async me(): Promise<AuthUser> {
    return this.request<AuthUser>('/api/v1/auth/me')
  }`,
  ]
}

const CLIENT_CORE = `export interface RequestOptions {
  signal?: AbortSignal
}

export interface ListParams {
  filter?: string
  sort?: string
  limit?: number
  offset?: number
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string; details?: unknown }
}

export class MungilApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MungilApiError'
  }
}

export class MungilClient {
  accessToken: string | null
  refreshToken: string | null
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: {
    baseUrl: string
    accessToken?: string | null
    refreshToken?: string | null
    fetch?: typeof fetch
  }) {
    this.baseUrl = options.baseUrl.replace(/\\/+$/, '')
    this.accessToken = options.accessToken ?? null
    this.refreshToken = options.refreshToken ?? null
    this.fetchImpl = options.fetch ?? fetch
  }

  setTokens(accessToken: string | null, refreshToken: string | null): void {
    this.accessToken = accessToken
    this.refreshToken = refreshToken
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.accessToken) headers.set('authorization', \`Bearer \${this.accessToken}\`)
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }

    const response = await this.fetchImpl(\`\${this.baseUrl}\${path}\`, { ...init, headers })
    if (!response.ok) await this.raise(response)
    return response
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private async raise(response: Response): Promise<never> {
    let payload: ApiErrorPayload | null = null
    try {
      payload = (await response.json()) as ApiErrorPayload
    } catch {
      // Not a MungilBase error envelope.
    }

    const error = payload?.error
    throw new MungilApiError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? response.statusText,
      error?.details,
    )
  }`

/**
 * Generates a dependency-free TypeScript client from the same config that
 * drives the API. The output is committed by the user (or generated in CI).
 */
export function generateSdk(config: MungilConfig, options: { version?: string } = {}): string {
  const lines: string[] = [
    `/* Generated by \`npm run sdk\` from the MungilBase config. Do not edit by hand. */`,
    `/* MungilBase ${options.version ?? VERSION} */`,
    ``,
    `export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }`,
    ``,
  ]

  for (const table of config.tables) lines.push(...tableInterfaces(table), '')
  if (config.auth) lines.push(...authTypes(), '')

  lines.push(CLIENT_CORE, '')

  lines.push(`  // Tables`)
  for (const table of config.tables) lines.push(...tableMethods(table), '')

  if (config.auth) {
    lines.push(`  // Auth`)
    lines.push(...authMethods())
  }

  lines.push(`}`)

  return `${lines.join('\n')}\n`
}

export function sdkMethodNames(config: MungilConfig): string[] {
  return config.tables.flatMap((table) => {
    const name = pascal(table.name)
    return [
      `list${name}`,
      `get${name}`,
      `create${name}`,
      `update${name}`,
      `delete${name}`,
      ...table.fields
        .filter((field) => field.type === 'file')
        .flatMap((field) => [`upload${name}${pascal(field.name)}`, `download${name}${pascal(field.name)}`]),
    ]
  })
}

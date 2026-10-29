import type { FieldConfig, MungilConfig, TableConfig } from '../config/schema.js'

type Schema = Record<string, unknown>
type Operation = Record<string, unknown>
type PathItem = Record<string, Operation>

/** Public reads may be anonymous; the bearer scheme is offered when present. */
const PUBLIC_OR_BEARER = [{ bearerAuth: [] }, {}]

const ERROR_SCHEMA: Schema = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'request_id'],
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        request_id: { type: 'string' },
        details: {},
      },
    },
  },
}

function ref(name: string): Schema {
  return { $ref: `#/components/schemas/${name}` }
}

function jsonResponse(description: string, schema: Schema): Schema {
  return { description, content: { 'application/json': { schema } } }
}

function errorResponse(description: string): Schema {
  return jsonResponse(description, ref('Error'))
}

function fieldSchema(field: FieldConfig): Schema {
  switch (field.type) {
    case 'text':
    case 'date':
      return { type: 'string' }
    case 'integer':
      return { type: 'integer' }
    case 'real':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'json':
      return {}
    case 'file':
      return { type: 'string', description: 'Storage key set by the file upload route' }
  }
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] }
}

function readSchema(table: TableConfig): Schema {
  const properties: Record<string, Schema> = { id: { type: 'string' } }
  const required: string[] = ['id']

  for (const field of table.fields) {
    properties[field.name] = field.required ? fieldSchema(field) : nullable(fieldSchema(field))
    if (field.required) required.push(field.name)
  }

  if (table.timestamps) {
    properties.created_at = { type: 'string', format: 'date-time' }
    properties.updated_at = { type: 'string', format: 'date-time' }
    required.push('created_at', 'updated_at')
  }

  return { type: 'object', required, properties }
}

function createSchema(table: TableConfig): Schema {
  const properties: Record<string, Schema> = {}
  const required: string[] = []

  for (const field of table.fields) {
    properties[field.name] = fieldSchema(field)
    if (field.required && field.default === undefined) required.push(field.name)
  }

  return { type: 'object', required, additionalProperties: false, properties }
}

function updateSchema(table: TableConfig): Schema {
  const properties: Record<string, Schema> = {}
  for (const field of table.fields) properties[field.name] = fieldSchema(field)

  return { type: 'object', additionalProperties: false, minProperties: 1, properties }
}

const LIST_PARAMETERS: Schema[] = [
  {
    name: 'filter',
    in: 'query',
    required: false,
    description: 'MungilBase rule expression. Values are bound; columns are validated.',
    schema: { type: 'string' },
  },
  {
    name: 'sort',
    in: 'query',
    required: false,
    description: 'Column name, or `-column` for descending.',
    schema: { type: 'string' },
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: 'offset',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, default: 0 },
  },
]

function idParameter(): Schema {
  return { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
}

function addTable(schemas: Record<string, Schema>, paths: Record<string, PathItem>, table: TableConfig): void {
  const read = `${table.name}Read`
  const create = `${table.name}Create`
  const update = `${table.name}Update`

  schemas[read] = readSchema(table)
  schemas[create] = createSchema(table)
  schemas[update] = updateSchema(table)

  paths[`/api/v1/${table.name}`] = {
    get: {
      summary: `List ${table.name}`,
      description: `Rows visible under the \`list\` rule. Denied rows are never returned.`,
      parameters: LIST_PARAMETERS,
      responses: {
        200: jsonResponse(`Visible ${table.name} rows`, {
          type: 'object',
          required: ['items', 'limit', 'offset'],
          properties: {
            items: { type: 'array', items: ref(read) },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
        }),
        400: errorResponse('Invalid filter, sort or pagination'),
        500: errorResponse('Internal error'),
      },
      security: PUBLIC_OR_BEARER,
    },
    post: {
      summary: `Create ${table.name}`,
      description: 'Enforced by the `create` rule. A denied create returns 403 and inserts nothing.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(create) } },
      },
      responses: {
        201: jsonResponse('Created row', ref(read)),
        400: errorResponse('Validation, foreign key or check failure'),
        401: errorResponse('Missing or invalid access token'),
        403: errorResponse('Denied by the create rule'),
        409: errorResponse('Unique constraint conflict'),
        500: errorResponse('Internal error'),
      },
      security: PUBLIC_OR_BEARER,
    },
  }

  paths[`/api/v1/${table.name}/{id}`] = {
    get: {
      summary: `View ${table.name}`,
      description: 'Rows the `view` rule hides are reported as 404, never as 403.',
      parameters: [idParameter()],
      responses: {
        200: jsonResponse(`A ${table.name} row`, ref(read)),
        404: errorResponse('Not found or not visible'),
        500: errorResponse('Internal error'),
      },
      security: PUBLIC_OR_BEARER,
    },
    patch: {
      summary: `Update ${table.name}`,
      description: 'Enforced by the `update` rule. Denied visible rows return 403; invisible rows return 404.',
      parameters: [idParameter()],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(update) } },
      },
      responses: {
        200: jsonResponse('Updated row', ref(read)),
        400: errorResponse('Validation, foreign key or check failure'),
        401: errorResponse('Missing or invalid access token'),
        403: errorResponse('Denied by the update rule'),
        404: errorResponse('Not found or not visible'),
        409: errorResponse('Unique constraint conflict'),
        500: errorResponse('Internal error'),
      },
      security: PUBLIC_OR_BEARER,
    },
    delete: {
      summary: `Delete ${table.name}`,
      description: 'Enforced by the `delete` rule.',
      parameters: [idParameter()],
      responses: {
        200: jsonResponse('Deleted row', ref(read)),
        401: errorResponse('Missing or invalid access token'),
        403: errorResponse('Denied by the delete rule'),
        404: errorResponse('Not found or not visible'),
        500: errorResponse('Internal error'),
      },
      security: PUBLIC_OR_BEARER,
    },
  }
}

function addAuth(schemas: Record<string, Schema>, paths: Record<string, PathItem>): void {
  schemas.Credentials = {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 1024 },
    },
  }
  schemas.AuthUser = {
    type: 'object',
    required: ['id', 'email', 'role', 'emailVerified'],
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string', enum: ['user', 'admin'] },
      emailVerified: { type: 'boolean' },
    },
  }
  schemas.TokenPair = {
    type: 'object',
    required: ['accessToken', 'refreshToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'],
    properties: {
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      accessTokenExpiresAt: { type: 'string', format: 'date-time' },
      refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
    },
  }
  schemas.AuthSession = {
    type: 'object',
    required: ['user', 'tokens'],
    properties: { user: ref('AuthUser'), tokens: ref('TokenPair') },
  }

  const credentialsBody = {
    required: true,
    content: { 'application/json': { schema: ref('Credentials') } },
  }

  paths['/api/v1/auth/register'] = {
    post: {
      summary: 'Register',
      description: 'Only available when `auth.allowSignup` is true.',
      requestBody: credentialsBody,
      responses: {
        201: jsonResponse('Account and tokens', ref('AuthSession')),
        400: errorResponse('Invalid email or password'),
        403: errorResponse('Signup is disabled'),
        409: errorResponse('Email already registered'),
        429: errorResponse('Too many attempts from this address'),
      },
      security: [],
    },
  }

  paths['/api/v1/auth/login'] = {
    post: {
      summary: 'Log in',
      requestBody: credentialsBody,
      responses: {
        200: jsonResponse('Account and tokens', ref('AuthSession')),
        400: errorResponse('Malformed request'),
        401: errorResponse('Invalid email or password'),
        429: errorResponse('Account or address is throttled'),
      },
      security: [],
    },
  }

  paths['/api/v1/auth/refresh'] = {
    post: {
      summary: 'Rotate tokens',
      description: 'Single-use refresh token. Replaying one revokes the whole session family.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              additionalProperties: false,
              properties: { refreshToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        200: jsonResponse('New tokens', ref('AuthSession')),
        400: errorResponse('Malformed request'),
        401: errorResponse('Invalid, expired or replayed refresh token'),
      },
      security: [],
    },
  }

  paths['/api/v1/auth/logout'] = {
    post: {
      summary: 'Log out',
      responses: {
        204: { description: 'Session revoked (idempotent)' },
      },
      security: [{ bearerAuth: [] }],
    },
  }

  paths['/api/v1/auth/me'] = {
    get: {
      summary: 'Current user',
      responses: {
        200: jsonResponse('The authenticated user', ref('AuthUser')),
        401: errorResponse('Missing or invalid access token'),
      },
      security: [{ bearerAuth: [] }],
    },
  }
}

function addPasswordReset(paths: Record<string, PathItem>): void {
  paths['/api/v1/auth/request-password-reset'] = {
    post: {
      summary: 'Request a password reset',
      description:
        'Always returns 202 for a well-formed address, whether or not an account exists. Throttled per address and per IP.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              additionalProperties: false,
              properties: { email: { type: 'string', format: 'email', maxLength: 254 } },
            },
          },
        },
      },
      responses: {
        202: jsonResponse('Accepted', {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', const: 'accepted' } },
        }),
        400: errorResponse('Malformed request'),
        429: errorResponse('Address or IP is throttled'),
      },
      security: [],
    },
  }

  paths['/api/v1/auth/reset-password'] = {
    post: {
      summary: 'Complete a password reset',
      description: 'Consumes a single-use token and revokes every session for the account.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'password'],
              additionalProperties: false,
              properties: {
                token: { type: 'string' },
                password: { type: 'string', maxLength: 1024 },
              },
            },
          },
        },
      },
      responses: {
        200: jsonResponse('Password changed', {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', const: 'ok' } },
        }),
        400: errorResponse('Invalid or expired token, or a weak password'),
      },
      security: [],
    },
  }
}

function addEmailVerification(paths: Record<string, PathItem>): void {
  paths['/api/v1/auth/verify-email'] = {
    post: {
      summary: 'Verify an email address',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              additionalProperties: false,
              properties: { token: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        200: jsonResponse('Verified', {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', const: 'ok' } },
        }),
        400: errorResponse('Invalid, expired or reused token'),
      },
      security: [],
    },
  }

  paths['/api/v1/auth/resend-verification'] = {
    post: {
      summary: 'Resend the verification email',
      responses: {
        202: jsonResponse('Accepted', {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', const: 'accepted' } },
        }),
        401: errorResponse('Missing or invalid access token'),
        429: errorResponse('Too many requests'),
      },
      security: [{ bearerAuth: [] }],
    },
  }
}

/**
 * Builds an OpenAPI 3.1 document from the same config that drives routing.
 * The spec cannot drift from the API for anything it describes.
 */
export function buildOpenApi(config: MungilConfig, version: string): Record<string, unknown> {
  const schemas: Record<string, Schema> = { Error: ERROR_SCHEMA }
  const paths: Record<string, PathItem> = {}

  for (const table of config.tables) addTable(schemas, paths, table)
  if (config.auth) {
    addAuth(schemas, paths)
    if (config.email && config.auth.passwordReset.enabled) addPasswordReset(paths)
    if (config.email && config.auth.emailVerification.enabled) addEmailVerification(paths)
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'MungilBase',
      version,
      description:
        'Generated from the MungilBase config. Access is enforced by table rules compiled into SQL.',
    },
    ...(config.appUrl ? { servers: [{ url: config.appUrl }] } : {}),
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Opaque access token' },
      },
    },
  }
}

import { z } from 'zod'

/**
 * Everything a MungilBase deployment knows about itself lives in this schema.
 * If it is not here, it is not configurable in v0.1.
 */

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use lowercase letters, digits and underscores; start with a letter')

export const fieldTypeSchema = z.enum(['text', 'integer', 'real', 'boolean', 'json', 'date'])

export const fieldSchema = z
  .object({
    name: identifier,
    type: fieldTypeSchema,
    required: z.boolean().default(false),
    unique: z.boolean().default(false),
    /** Only literals are supported in v0.1. Expressions arrive with the query DSL. */
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    references: z
      .object({
        table: identifier,
        column: identifier,
      })
      .strict()
      .optional(),
  })
  .strict()

/**
 * A rule is a boolean expression evaluated inside SQL.
 * - `null`  -> deny everyone (the safe default)
 * - `'true'` -> allow everyone
 * - anything else -> a MungilBase expression, e.g. `auth.uid == owner_id`
 *
 * Rules are required for all five operations so that "open by accident" is
 * impossible: you must type `null` to close a door, and `'true'` to open one.
 */
export const ruleSchema = z.union([z.null(), z.string().min(1).max(2000)])

export const rulesSchema = z
  .object({
    list: ruleSchema,
    view: ruleSchema,
    create: ruleSchema,
    update: ruleSchema,
    delete: ruleSchema,
  })
  .strict()

export const authConfigSchema = z
  .object({
    /** Registration endpoint is closed unless this is true. */
    allowSignup: z.boolean().default(false),
    minPasswordLength: z.number().int().min(8).max(128).default(10),
    accessTokenTtlSeconds: z.number().int().min(60).max(86_400).default(900),
    refreshTokenTtlSeconds: z.number().int().min(3_600).max(31_536_000).default(2_592_000),
    /** Absolute cap on a session's lifetime, even with sliding refreshes. */
    maxSessionTtlSeconds: z.number().int().min(3_600).max(31_536_000).default(7_776_000),
    throttle: z
      .object({
        account: z
          .object({
            maxAttempts: z.number().int().min(1).max(1_000).default(5),
            windowSeconds: z.number().int().min(60).max(86_400).default(900),
          })
          .default({}),
        ip: z
          .object({
            maxAttempts: z.number().int().min(1).max(10_000).default(30),
            windowSeconds: z.number().int().min(60).max(86_400).default(600),
          })
          .default({}),
      })
      .default({}),
    passwordReset: z
      .object({
        enabled: z.boolean().default(true),
        tokenTtlSeconds: z.number().int().min(300).max(86_400).default(1_800),
        maxRequestsPerHour: z.number().int().min(1).max(100).default(3),
        /** Frontend URL that receives `?token=…`. Defaults to `${appUrl}/reset-password`. */
        resetUrl: z.string().url().optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export const emailConfigSchema = z
  .object({
    /**
     * `log` prints the message to stdout. Development only: a reset link in
     * production logs is a credential leak.
     */
    provider: z.enum(['log', 'smtp']).default('log'),
    from: z.string().min(3).max(320),
    smtp: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65_535).default(587),
        secure: z.boolean().default(false),
        user: z.string().min(1).optional(),
        /** Name of the env var holding the password. Never the password itself. */
        passwordEnv: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/, 'Use an environment variable name')
          .default('MUNGIL_SMTP_PASSWORD'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((email, ctx) => {
    if (email.provider === 'smtp' && !email.smtp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smtp'],
        message: 'smtp settings are required when provider is "smtp"',
      })
    }
  })

export const tableSchema = z
  .object({
    name: identifier,
    fields: z.array(fieldSchema).min(1),
    rules: rulesSchema,
    /** Adds `created_at` / `updated_at` columns maintained by the engine. */
    timestamps: z.boolean().default(true),
    /**
     * Extra indexes for hot filters. Each entry is a column name or a
     * composite list, e.g. `['done', 'created_at']`.
     */
    indexes: z
      .array(z.union([identifier, z.array(identifier).min(1).max(8)]))
      .max(20)
      .default([]),
  })
  .strict()

export const configSchema = z
  .object({
    appUrl: z.string().url().optional(),
    server: z
      .object({
        host: z.string().min(1).default('0.0.0.0'),
        port: z.number().int().min(1).max(65535).default(8787),
        /** Requests in flight before new ones are shed with 503. */
        maxConcurrency: z.number().int().min(1).max(10_000).default(64),
      })
      .default({}),
    database: z
      .object({
        file: z.string().min(1).default('./data/mungil.db'),
      })
      .default({}),
    /** Browser origins allowed to call the API. Empty means same-origin only. */
    allowedOrigins: z.array(z.string().url()).default([]),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** Omit to disable authentication routes entirely. */
    auth: authConfigSchema.optional(),
    /** Required for password reset emails. */
    email: emailConfigSchema.optional(),
    tables: z.array(tableSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const tableNames = new Set<string>()

    for (const [tableIndex, table] of config.tables.entries()) {
      if (table.name === 'auth') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tables', tableIndex, 'name'],
          message: 'Table name "auth" is reserved for the auth routes',
        })
      }
      if (tableNames.has(table.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tables', tableIndex, 'name'],
          message: `Duplicate table "${table.name}"`,
        })
      }
      tableNames.add(table.name)

      const fieldNames = new Set<string>()
      const reserved = new Set(['id'])
      if (table.timestamps) {
        reserved.add('created_at')
        reserved.add('updated_at')
      }

      for (const [fieldIndex, field] of table.fields.entries()) {
        const path = ['tables', tableIndex, 'fields', fieldIndex, 'name']
        if (fieldNames.has(field.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate field "${field.name}"` })
        }
        if (reserved.has(field.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Field name "${field.name}" is reserved` })
        }
        if (field.required && field.default === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tables', tableIndex, 'fields', fieldIndex, 'default'],
            message: 'A required field cannot default to null',
          })
        }
        fieldNames.add(field.name)
      }
    }

    // References are checked after all table names are known.
    for (const [tableIndex, table] of config.tables.entries()) {
      for (const [fieldIndex, field] of table.fields.entries()) {
        if (!field.references) continue
        const path = ['tables', tableIndex, 'fields', fieldIndex, 'references']
        const target = config.tables.find((t) => t.name === field.references?.table)
        if (!target) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `References unknown table "${field.references.table}"`,
          })
          continue
        }
        if (!tableHasColumn(target, field.references.column)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `References unknown column "${field.references.table}.${field.references.column}"`,
          })
        }
      }

      for (const [indexIndex, entry] of table.indexes.entries()) {
        const columns = Array.isArray(entry) ? entry : [entry]
        if (new Set(columns).size !== columns.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tables', tableIndex, 'indexes', indexIndex],
            message: 'An index cannot repeat a column',
          })
        }
        for (const column of columns) {
          if (!tableHasColumn(table, column)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['tables', tableIndex, 'indexes', indexIndex],
              message: `Index references unknown column "${column}"`,
            })
          }
        }
      }
    }

    if (config.email && config.auth?.passwordReset.enabled) {
      if (!config.appUrl && !config.auth.passwordReset.resetUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['appUrl'],
          message: 'Password reset needs appUrl or auth.passwordReset.resetUrl to build the link',
        })
      }
    }
  })

export type FieldType = z.infer<typeof fieldTypeSchema>
export type FieldConfig = z.infer<typeof fieldSchema>
export type AuthConfig = z.infer<typeof authConfigSchema>
export type EmailConfig = z.infer<typeof emailConfigSchema>
export type RuleConfig = z.infer<typeof ruleSchema>
export type RulesConfig = z.infer<typeof rulesSchema>
export type TableConfig = z.infer<typeof tableSchema>
export type MungilConfig = z.infer<typeof configSchema>
/** What a config file may contain before defaults are applied. */
export type MungilConfigInput = z.input<typeof configSchema>

export type TableOperation = keyof RulesConfig

export function rulesFor(table: TableConfig, operation: TableOperation): RuleConfig {
  return table.rules[operation]
}

/**
 * Columns that exist on every table without being declared.
 * Foreign keys must be able to reference `id`, and rules must be able to
 * mention timestamp columns, so this list is shared by validation and the
 * query engine.
 */
export function tableHasColumn(table: TableConfig, column: string): boolean {
  if (column === 'id') return true
  if (table.timestamps && (column === 'created_at' || column === 'updated_at')) return true
  return table.fields.some((field) => field.name === column)
}

export function tableColumns(table: TableConfig): Set<string> {
  const columns = new Set(table.fields.map((field) => field.name))
  columns.add('id')
  if (table.timestamps) {
    columns.add('created_at')
    columns.add('updated_at')
  }
  return columns
}

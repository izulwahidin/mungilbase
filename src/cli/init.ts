import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CONFIG_CANDIDATES } from '../config/load.js'

export interface InitOptions {
  directory?: string
  force?: boolean
  /** Write `mungil.config.json` instead of a TypeScript config. */
  json?: boolean
}

export interface InitResult {
  directory: string
  created: string[]
  skipped: string[]
}

const TYPESCRIPT_CONFIG = `/**
 * MungilBase config. It is validated at boot, so a typo is a startup error
 * rather than a runtime surprise.
 *
 * Docs: https://github.com/izulwahidin/mungilbase#config
 *
 * Tip: run \`npm install --save-dev mungilbase\` in this project to get editor
 * autocomplete from \`import type { MungilConfigInput } from 'mungilbase/config'\`.
 */
export default {
  appUrl: 'http://localhost:8787',
  server: { host: '0.0.0.0', port: 8787 },
  database: { file: './data/mungil.db' },
  storage: { local: { dir: './data/files' } },
  auth: {
    // Signup is closed by default in production; open it while you build.
    allowSignup: true,
  },
  tables: [
    {
      name: 'notes',
      fields: [
        // An \`auth.uid\` value, not a foreign key: auth users live in _mungil_* tables.
        { name: 'owner_id', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
      ],
      // Every operation must be explicit. null = deny, 'true' = allow.
      rules: {
        list: 'published == true | auth.uid == owner_id',
        view: 'published == true | auth.uid == owner_id',
        create: 'auth.uid != null & owner_id == auth.uid',
        update: 'auth.uid == owner_id',
        delete: 'auth.uid == owner_id',
      },
      indexes: ['owner_id', 'published'],
    },
  ],
}
`

const JSON_CONFIG = `{
  "appUrl": "http://localhost:8787",
  "server": { "host": "0.0.0.0", "port": 8787 },
  "database": { "file": "./data/mungil.db" },
  "storage": { "local": { "dir": "./data/files" } },
  "auth": { "allowSignup": true },
  "tables": [
    {
      "name": "notes",
      "fields": [
        { "name": "owner_id", "type": "text", "required": true },
        { "name": "title", "type": "text", "required": true },
        { "name": "body", "type": "text" },
        { "name": "published", "type": "boolean", "default": false }
      ],
      "rules": {
        "list": "published == true | auth.uid == owner_id",
        "view": "published == true | auth.uid == owner_id",
        "create": "auth.uid != null & owner_id == auth.uid",
        "update": "auth.uid == owner_id",
        "delete": "auth.uid == owner_id"
      },
      "indexes": ["owner_id", "published"]
    }
  ]
}
`

const ENV_EXAMPLE = `# Optional overrides. The defaults in mungil.config.ts work for local use.
MUNGIL_CONFIG=./mungil.config.ts
MUNGIL_DB_FILE=./data/mungil.db
MUNGIL_VERSION=

# Set to 1 only when a trusted reverse proxy sets X-Forwarded-For.
MUNGIL_TRUST_PROXY=

# Require a bearer token on GET /metrics.
MUNGIL_METRICS_TOKEN=

# Optional Sentry-compatible DSN.
MUNGIL_SENTRY_DSN=

# OAuth client secrets.
MUNGIL_GOOGLE_CLIENT_SECRET=
MUNGIL_GITHUB_CLIENT_SECRET=

# S3-compatible object storage (storage.provider = "s3").
MUNGIL_S3_ACCESS_KEY_ID=
MUNGIL_S3_SECRET_ACCESS_KEY=

# Used once by \`mungilbase user create|passwd\`.
MUNGIL_USER_PASSWORD=
MUNGIL_USER_ROLE=user

# SMTP password (see email.smtp.passwordEnv).
MUNGIL_SMTP_PASSWORD=
`

const GITIGNORE = `# MungilBase runtime data
data/
backups/
*.db
*.db-wal
*.db-shm

# Secrets
.env
.env.*
!.env.example

# Keep generated clients if you want; uncomment to ignore.
# sdk/
`

/**
 * Scaffolds a project that `npx mungilbase start` can run immediately.
 * Existing files are left alone unless `force` is set.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const directory = resolve(options.directory ?? '.')
  const configName = options.json ? 'mungil.config.json' : 'mungil.config.ts'

  const existingConfigs = CONFIG_CANDIDATES.map((name) => join(directory, name)).filter((path) =>
    existsSync(path),
  )
  if (existingConfigs.length && !options.force) {
    throw new Error(
      `${existingConfigs[0]} already exists. Pass --force to overwrite it, or run init in an empty directory.`,
    )
  }

  await mkdir(directory, { recursive: true })

  const files: Array<{ name: string; contents: string }> = [
    { name: configName, contents: options.json ? JSON_CONFIG : TYPESCRIPT_CONFIG },
    { name: '.env.example', contents: ENV_EXAMPLE },
    { name: '.gitignore', contents: GITIGNORE },
  ]

  const created: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    const path = join(directory, file.name)
    if (existsSync(path) && !options.force) {
      skipped.push(path)
      continue
    }
    await writeFile(path, file.contents, 'utf8')
    created.push(path)
  }

  return { directory, created, skipped }
}

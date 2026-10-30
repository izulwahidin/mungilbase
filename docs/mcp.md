# MCP for AI agents

MungilBase ships a [Model Context Protocol](https://modelcontextprotocol.io)
server. It exposes your configured tables as tools over stdio, so Claude
Desktop, Cursor, Codex, and other MCP clients can read data, write data,
manage accounts, run migrations, and (with a second opt-in) execute SQL.

The important part: **MCP uses the same CRUD functions, validation and
row-level rules as the HTTP API.** There is no second query path and no way for
an agent to opt out of a rule.

The transport is stdio in this release: the agent starts `mungilbase mcp` as a
child process. Remote/HTTP MCP transports are not exposed.

## Start the server

```bash
npx mungilbase mcp
```

That is anonymous and **read-only**: rules that require `auth.uid` will deny or
hide rows, and mutating tools are not registered at all.

A useful setup for a local agent:

```bash
npx mungilbase mcp \
  --user agent@example.com \
  --tables notes,posts \
  --allow-write
```

| Option | Meaning |
|---|---|
| `--user <email>` | Evaluate every tool call as this account. Omit for anonymous. |
| `--tables a,b` | Expose only these tables. Omit for every configured table. |
| `--allow-write` | Register `create_row`, `update_row` and `delete_row`. |
| `--admin` | Register operator tools (schema, users, backups, audit). Requires `--user` with the `admin` role. |
| `--allow-raw-sql` | Register `query_sql` and `execute_sql`. Requires `--admin`. |
| `--config <path>` | Config file (otherwise `MUNGIL_CONFIG` or `mungil.config.*`). |

The account must already exist:

```bash
MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create agent@example.com
```

Email verification is honored when `auth.emailVerification.required` is true.
Admin bypass is also honored, but only when `auth.adminBypassRules` is enabled;
`--user` alone never becomes a bypass.

## Admin mode

Admin tools are opt-in twice: the operator passes `--admin`, **and** the
selected account must already have the `admin` role. There is no path for an
agent to promote itself.

```bash
# bootstrap the first admin with the CLI
MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create admin@example.com --role admin

# then expose admin tools, data writes, and raw SQL
npx mungilbase mcp \
  --user admin@example.com \
  --admin \
  --allow-write \
  --allow-raw-sql
```

`--allow-raw-sql` requires `--admin` and adds two tools that bypass table
rules entirely:

- `query_sql` — one read-only statement with SQLite `query_only` enabled and a
  row cap (default 200, max 1000). Writes are rejected.
- `execute_sql` — arbitrary SQL, including writes and DDL. Every call is
  audited, including failures.

Use admin mode on a trusted workstation against a trusted database. Prefer the
CLI for production changes when you do not need an agent in the loop.

## Tools

Read-only, always registered:

| Tool | What it does |
|---|---|
| `whoami` | Active identity, write flag, exposed tables |
| `list_tables` | Table names, fields and rules |
| `describe_table` | One table's fields, defaults, indexes and five rules |
| `list_rows` | Rule-filtered list with `filter`, `sort`, `limit`, `offset` |
| `get_row` | One row by id, or `not_found` when the view rule hides it |
| `get_openapi` | OpenAPI 3.1 document limited to exposed tables |

Registered only with `--allow-write`:

| Tool | What it does |
|---|---|
| `create_row` | Insert a row; the create rule runs inside SQLite |
| `update_row` | Patch a row; only provided fields change |
| `delete_row` | Delete a row and its referenced files |

Registered only with `--admin` (requires an admin identity):

| Tool | What it does |
|---|---|
| `get_config` | Validated config and its path |
| `database_info` | SQLite version, journal mode, page counts and sizes |
| `list_migrations` | Known migrations and which are applied |
| `migrate` | Apply code migrations + additive schema sync |
| `list_users` | Accounts, roles and verification status |
| `create_user` | Create an account, optionally generating a password |
| `set_user_role` | Change `user` / `admin` |
| `reset_user_password` | Set a password and revoke all sessions |
| `delete_user` | Delete an account and its sessions |
| `list_audit` | Filter the audit log |
| `backup_database` | Verified online SQLite backup |
| `files_gc` | Find or delete unreferenced uploads |
| `generate_sdk` | Write the typed TypeScript client |

Registered only with `--admin --allow-raw-sql`:

| Tool | What it does |
|---|---|
| `query_sql` | One read-only SQL statement, row-capped |
| `execute_sql` | Arbitrary SQL, including writes and DDL |

Resources:

| URI | Contents |
|---|---|
| `mungilbase://schema` | JSON schema summary |
| `mungilbase://openapi.json` | OpenAPI 3.1 document |

File fields cannot be written over MCP. Use the HTTP upload route:
`POST /api/v1/:table/:id/files/:field`.

## Client configuration

Generate the entry instead of writing it by hand:

```bash
mungilbase mcp --print-config opencode          # opencode.json
mungilbase mcp --print-config cursor --write    # .cursor/mcp.json
mungilbase mcp --print-config vscode --write    # .vscode/mcp.json
mungilbase mcp --print-config claude --write    # Claude Desktop config
mungilbase mcp --print-config raw               # generic { command, args }
```

The printed command is the Node binary plus the absolute path to the mungilbase
CLI file, with an absolute `--config`. It deliberately does **not** use `npx`:
the npm wrapper starts an extra process in front of the server and some clients
do not forward stdin/stdout through it, so the handshake times out even though
the server is running.

Before wiring a client, prove the server works:

```bash
mungilbase mcp --check
# MCP check ok — 0.6.0
# Config    /srv/app/mungil.config.ts
# Database  /srv/app/data/mungil.db
# Identity  agent@example.com
# Access    write=on admin=off rawSql=off
# Tables    notes, posts
# Tools     9: whoami, list_tables, ...
```

Defaults belong in the config, so the client entry stays short and can be the
same on every machine:

```ts
mcp: { user: 'agent@example.com', tables: ['notes', 'posts'], allowWrite: true },
```

Command-line flags win over the config. A generated entry therefore repeats the
effective flags; delete them from the config and the entry together.

### Claude Desktop

`mungilbase mcp --print-config claude --write` updates the file at the platform
default location. Restart Claude Desktop afterwards. If you copy the entry by
hand, use absolute paths:

```json
{
  "mcpServers": {
    "mungilbase": {
      "command": "/usr/local/bin/node",
      "args": [
        "/srv/app/node_modules/mungilbase/dist/cli/main.js",
        "mcp",
        "--config",
        "/srv/app/mungil.config.ts"
      ]
    }
  }
}
```

### Cursor

`mungilbase mcp --print-config cursor --write` creates `.cursor/mcp.json` with:

```json
{
  "mcpServers": {
    "mungilbase": {
      "command": "/usr/local/bin/node",
      "args": [
        "/srv/app/node_modules/mungilbase/dist/cli/main.js",
        "mcp",
        "--config",
        "/srv/app/mungil.config.ts"
      ]
    }
  }
}
```

### OpenCode

```bash
mungilbase mcp --print-config opencode --write
```

writes `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mungilbase": {
        "type": "local",
        "command": ["/usr/local/bin/node", "/srv/app/node_modules/mungilbase/dist/cli/main.js", "mcp", "--config", "/srv/app/mungil.config.ts"],
        "cwd": "/srv/app"
      }
    }
  }
}
```

### Any stdio MCP client

Run the CLI as a child process and talk JSON-RPC on stdin/stdout; diagnostics go
to stderr. Do not wrap stdout with a logger.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Client says "request timed out" but stderr shows `mcp_ready` | The launch path did not forward stdio (usually `npx`, or a shell wrapper) | Use `--print-config`; it emits the Node binary and the CLI file |
| `mcp_no_initialize` warning after 10s | Same as above: the server started but saw no request | Same fix |
| `No account with email …` | `--user` names an account that does not exist | `mungilbase user create … --generate-password` |
| `rule_violation` on every write | Writes enabled without an identity, so `auth.uid` is null | Pass `--user`, or set `mcp.user` |
| A different (empty) database | The old server resolved `database.file` from the process cwd | Relative paths now resolve from the config file; pass `--config` an absolute path |
| Client config has comments | `--write` only merges plain JSON | Add the printed entry by hand |

## What the agent sees

A typical tool sequence:

1. `whoami` — who am I, can I write?
2. `list_tables` / `describe_table` — real field names and rules.
3. `list_rows` with a filter — only rows the rules allow.
4. `create_row` / `update_row` / `delete_row` — when enabled and permitted.

Denials are tool errors carrying the same codes as HTTP:

```json
{ "error": { "code": "rule_violation", "message": "Creating posts is not allowed" } }
```

A row hidden by the `view` rule returns `not_found`; it is not distinguished
from a missing row.

## Security model

- Read-only by default. Writes require an explicit operator flag.
- Anonymous by default. `--user` chooses a real account for rule evaluation.
- Every rule is compiled and executed in SQLite, never in the agent process.
- `--tables` narrows the surface; tools for other tables reject requests.
- Admin tools require both `--admin` and an account whose role is `admin`.
- Raw SQL requires `--admin --allow-raw-sql`; `query_sql` is read-only, while
  `execute_sql` can bypass every rule and schema constraint.
- MCP writes append `mcp.create`, `mcp.update` and `mcp.delete` rows to the
  audit log. Admin and raw-SQL calls append `mcp.admin.*` rows, including
  failures and denied writes.
- Generated passwords are returned once in the tool result, so they appear in
  the agent transcript. Pass an explicit password if that is not acceptable.
- Files cannot be uploaded over MCP, and the config file cannot be edited by
  a tool. Use the HTTP upload route or edit the config and run `migrate`.
- MCP is an operator surface. Run it locally, with the same trust you give a
  shell that can open the database file.

For a production read-only endpoint, run MCP on the same host as the database
with a dedicated account and no `--allow-write`, `--admin` or
`--allow-raw-sql`.

## Programmatic use

```ts
import { openMcpContext } from 'mungilbase'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const context = await openMcpContext({
  configPath: './mungil.config.ts',
  user: 'agent@example.com',
  // admin: true,
  // allowRawSql: true,
})
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await context.server.connect(serverTransport)
// hand clientTransport to an MCP client in the same process
```

`createMcpServer` is exported from `mungilbase/mcp` for embedding without the
stdio transport.

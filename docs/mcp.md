# MCP for AI agents

MungilBase ships a [Model Context Protocol](https://modelcontextprotocol.io)
server. It exposes your configured tables as tools over stdio, so Claude
Desktop, Cursor, Codex, and other MCP clients can read and (optionally) write
data.

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
| `--config <path>` | Config file (otherwise `MUNGIL_CONFIG` or `mungil.config.*`). |

The account must already exist:

```bash
MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create agent@example.com
```

Email verification is honored when `auth.emailVerification.required` is true.
Admin bypass is also honored, but only when `auth.adminBypassRules` is enabled;
`--user` alone never becomes a bypass.

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

Resources:

| URI | Contents |
|---|---|
| `mungilbase://schema` | JSON schema summary |
| `mungilbase://openapi.json` | OpenAPI 3.1 document |

File fields cannot be written over MCP. Use the HTTP upload route:
`POST /api/v1/:table/:id/files/:field`.

## Client configuration

### Claude Desktop

Add this to `claude_desktop_config.json` (use absolute paths):

```json
{
  "mcpServers": {
    "mungilbase": {
      "command": "npx",
      "args": [
        "-y",
        "mungilbase",
        "mcp",
        "--config",
        "/absolute/path/to/mungil.config.ts",
        "--user",
        "agent@example.com",
        "--tables",
        "notes,posts",
        "--allow-write"
      ]
    }
  }
}
```

On Windows, Claude Desktop launches commands without a shell. Use:

```json
{
  "mcpServers": {
    "mungilbase": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "mungilbase", "mcp", "--config", "C:\\\\path\\\\mungil.config.ts"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "mungilbase": {
      "command": "npx",
      "args": ["-y", "mungilbase", "mcp", "--config", "./mungil.config.ts"]
    }
  }
}
```

### Any stdio MCP client

Run `npx mungilbase mcp` as a child process. The protocol uses stdin/stdout;
diagnostics go to stderr. Do not wrap stdout with a logger.

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
- MCP writes append `mcp.create`, `mcp.update` and `mcp.delete` rows to the
  audit log, including denied attempts.
- The agent cannot run raw SQL, change the config, upload files or manage users.
- MCP is an operator surface. Run it locally, with the same trust you give a
  shell that can open the database file.

For a production read-only endpoint, run MCP on the same host as the database
with a dedicated account and no `--allow-write`.

## Programmatic use

```ts
import { openMcpContext } from 'mungilbase'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const context = await openMcpContext({ configPath: './mungil.config.ts', user: 'agent@example.com' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await context.server.connect(serverTransport)
// hand clientTransport to an MCP client in the same process
```

`createMcpServer` is exported from `mungilbase/mcp` for embedding without the
stdio transport.

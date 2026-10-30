# Getting started

MungilBase is a single Node process with SQLite. There is no server to
provision and no dashboard to click through: you describe tables and access
rules in one config file, and it serves a REST API.

## Requirements

- Node.js 22.18 or newer
- npm (or another npm-compatible client)

## 1. Create a project

```bash
mkdir my-api
cd my-api
npx mungilbase init
```

`init` writes four files:

| File | Purpose |
|---|---|
| `mungil.config.ts` | Tables, fields, access rules, server settings |
| `public/index.html` | Frontend entry point, served by the same process |
| `.env.example` | Optional environment overrides and secrets |
| `.gitignore` | Keeps `data/`, backups and `.env` out of git |

The starter config defines a `notes` table, opens signup, and enables
`static: { dir: './public', spa: true }`, so `mungilbase start` serves the page
and the API on one port. Edit it before production: see
[config](../README.md#config).

Run `npx mungilbase init --json` if you prefer `mungil.config.json` (useful when
the deployment cannot run a TypeScript loader).

In a hurry? Skip to a working app:

```bash
npx mungilbase init --demo   # todos table, todo UI, seeded rows, demo account
npx mungilbase start         # http://localhost:8787
```

`--demo` migrates, seeds three rows and prints a generated password once.

## 2. Apply the schema

```bash
npx mungilbase migrate
```

This applies checksummed migrations and additively syncs the tables in your
config. It creates `./data/mungil.db` if needed. Destructive changes are
refused loudly instead of silently dropping data.

## 3. Start the server

```bash
npx mungilbase start
```

Defaults are `0.0.0.0:8787` from the config. Override per run:

```bash
npx mungilbase start --port 9000
```

Open <http://localhost:8787>: the scaffolded page calls `/health` and links to
the API, the OpenAPI document and the admin panel.

Check it:

```bash
curl localhost:8787/health
curl localhost:8787/version
```

While iterating on the config, `npx mungilbase dev` restarts the server and
regenerates `openapi.json` on every change.

## 4. Create an account

The first administrator is created in the browser: open
<http://localhost:8787/admin>. A deployment with no `admin` account shows the
setup screen once, and closes it as soon as the account exists. Everything after
that — rows, the schema, settings — is in the same panel.

The starter config has `auth.allowSignup: true`, so you can also register over
HTTP. To create an account without opening signup — or to add another admin —
use the CLI:

```bash
MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create me@example.com
MUNGIL_USER_PASSWORD='correct horse battery' npx mungilbase user create boss@example.com --role admin
```

`user create` starts the account verified. Change a role later with:

```bash
npx mungilbase user role boss@example.com admin
```

## 5. Call the API

```bash
TOKEN=$(curl -s localhost:8787/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery"}' \
  | jq -r .tokens.accessToken)

USER_ID=$(curl -s localhost:8787/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq -r .id)

curl -X POST localhost:8787/api/v1/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"owner_id\":\"$USER_ID\",\"title\":\"First note\"}"
```

List it back:

```bash
curl "localhost:8787/api/v1/notes?sort=-created_at" \
  -H "Authorization: Bearer $TOKEN"
```

Rules are enforced inside SQLite. A row your `view` rule hides returns `404`;
a write your rules reject returns `403 rule_violation`.

## 6. Connect an AI agent (optional)

```bash
npx mungilbase mcp --check
npx mungilbase mcp --print-config opencode --write
```

`--check` connects a real MCP client in-process and reports the identity,
tables and tools, so a config or rule problem fails here instead of inside your
agent. `--print-config` writes the client entry with the Node binary and
absolute paths — no `npx`, which does not always forward stdio.

Add `--allow-write` (or `mcp: { allowWrite: true }` in the config) for mutating
tools. Rule enforcement is identical to the HTTP API. See
[MCP for AI agents](mcp.md) for Claude Desktop and Cursor configuration.

## 7. Go further

- [CLI reference](cli.md) — every command, option and environment variable.
- [MCP for AI agents](mcp.md) — tools, client setup and the security model.
- [Configuration](../README.md#config) — tables, fields, rules, auth, email, storage.
- [OpenAPI](cli.md#openapi) — `npx mungilbase openapi` writes a 3.1 document.
- [Runbook](runbook.md) — backups, restores, upgrades, incidents.
- [Architecture](architecture.md) — how requests, rules and storage fit together.

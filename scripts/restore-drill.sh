#!/usr/bin/env bash
#
# Backup + restore drill.
#
# Proves, on a real SQLite file, that:
#   1. the schema can be created from config;
#   2. an online backup of a live database passes integrity and FK checks;
#   3. the source keeps working after the backup;
#   4. the snapshot can be restored and still satisfies the schema;
#   5. the restored copy contains the expected rows.
#
# Run it after changing anything in src/db or the backup path.
#   bash scripts/restore-drill.sh
#   KEEP=1 bash scripts/restore-drill.sh   # leave .drill/ for inspection
#
# Paths passed to Node are relative on purpose: on Windows/WSL, an absolute
# /mnt/c path is not readable by node.exe.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRILL_DIR="$ROOT/.drill"
KEEP="${KEEP:-0}"

# Under npm on WSL, PATH may not contain a `node` shim even though `node.exe`
# works. CI on Linux finds plain `node`.
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=node
  elif command -v node.exe >/dev/null 2>&1; then
    NODE_BIN=node.exe
  else
    echo "node is required to run the drill" >&2
    exit 1
  fi
fi

cleanup() {
  if [ "$KEEP" != "1" ]; then
    rm -rf "$DRILL_DIR"
  else
    echo "Kept drill artifacts in $DRILL_DIR"
  fi
}
trap cleanup EXIT

rm -rf "$DRILL_DIR"
mkdir -p "$DRILL_DIR/backups"

CONFIG="./.drill/source.config.json"
RESTORED_CONFIG="./.drill/restored.config.json"
DB="./.drill/source.db"
RESTORED="./.drill/restored.db"

write_config() {
  local file="$1"
  local db="$2"
  cat > "$file" <<JSON
{
  "database": { "file": "$db" },
  "tables": [
    {
      "name": "notes",
      "fields": [
        { "name": "title", "type": "text", "required": true },
        { "name": "done", "type": "boolean", "default": false }
      ],
      "rules": {
        "list": "true",
        "view": "true",
        "create": "true",
        "update": "true",
        "delete": "true"
      }
    }
  ]
}
JSON
}

write_config "$CONFIG" "$DB"
write_config "$RESTORED_CONFIG" "$RESTORED"

echo "1/5  creating schema and seed rows"
npx --no-install tsx src/cli/migrate.ts "$CONFIG" > /dev/null
"$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
const insert = db.prepare(
  "INSERT INTO \"notes\" (\"id\", \"title\", \"done\", \"created_at\", \"updated_at\") VALUES (?, ?, ?, ?, ?)"
);
const now = new Date().toISOString();
insert.run("note-1", "First note", 0, now, now);
insert.run("note-2", "Second note", 1, now, now);
db.close();
' "$DB"

echo "2/5  taking an online backup while the source stays open"
npx --no-install tsx src/cli/backup.ts "./.drill/backups" "$CONFIG" > "$DRILL_DIR/backup.json"
cat "$DRILL_DIR/backup.json"
SNAPSHOT="./.drill/backups/$(ls "$DRILL_DIR"/backups/*.db | head -n 1 | xargs -n 1 basename)"

echo "3/5  verifying the snapshot"
"$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const fk = db.prepare("PRAGMA foreign_key_check").all().length;
const rows = db.prepare("SELECT COUNT(*) AS c FROM \"notes\"").get().c;
db.close();
if (integrity !== "ok") throw new Error("integrity: " + integrity);
if (fk !== 0) throw new Error("foreign key violations: " + fk);
if (rows !== 2) throw new Error("expected 2 rows, found " + rows);
console.log(`     snapshot ok: ${rows} rows, integrity=${integrity}, fk_violations=${fk}`);
' "$SNAPSHOT"

echo "4/5  confirming the source is still writable after the backup"
"$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
const now = new Date().toISOString();
db.prepare("INSERT INTO \"notes\" (\"id\", \"title\", \"done\", \"created_at\", \"updated_at\") VALUES (?, ?, ?, ?, ?)")
  .run("note-3", "After backup", 0, now, now);
const rows = db.prepare("SELECT COUNT(*) AS c FROM \"notes\"").get().c;
db.close();
if (rows !== 3) throw new Error("source write failed after backup");
console.log(`     source writable: ${rows} rows`);
' "$DB"

echo "5/5  restoring the snapshot and re-checking the schema"
cp "$SNAPSHOT" "$RESTORED"
npx --no-install tsx src/cli/migrate.ts "$RESTORED_CONFIG" > /dev/null
"$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
const rows = db.prepare("SELECT COUNT(*) AS c FROM \"notes\"").get().c;
const titles = db.prepare("SELECT \"title\" FROM \"notes\" ORDER BY \"id\"").all().map((row) => row.title);
db.close();
if (rows !== 2) throw new Error("restored rows: " + rows);
if (titles.join(",") !== "First note,Second note") throw new Error("restored titles: " + titles.join(","));
console.log(`     restore ok: ${rows} rows -> ${titles.join(" | ")}`);
' "$RESTORED"

echo
echo "PASS  backup and restore drill completed"

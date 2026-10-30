#!/usr/bin/env bash
#
# Everything CI runs, in the same order, so it can be executed anywhere:
#   npm run ci
#
# Used by .github/workflows/ci.yml and by the optional pre-push hook.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# WSL + nvm4w often has node.exe but no `node` on PATH for bash.
if command -v node >/dev/null 2>&1; then
  NODE_BIN=node
elif command -v node.exe >/dev/null 2>&1; then
  NODE_BIN=node.exe
else
  echo "node is required to run CI" >&2
  exit 1
fi

echo "==> typecheck + tests + build"
npm run check

echo "==> CLI and package smoke test"
"$NODE_BIN" dist/cli/main.js --version
"$NODE_BIN" dist/cli/main.js --help > /dev/null
npm pack --dry-run > /dev/null

echo "==> backup + restore drill"
bash scripts/restore-drill.sh

echo
echo "PASS  local CI completed"

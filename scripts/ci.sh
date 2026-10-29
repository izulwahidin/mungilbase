#!/usr/bin/env bash
#
# Everything CI runs, in the same order, so it can be executed anywhere:
#   npm run ci
#
# Used by .github/workflows/ci.yml and by the optional pre-push hook.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> typecheck + tests + build"
npm run check

echo "==> backup + restore drill"
bash scripts/restore-drill.sh

echo
echo "PASS  local CI completed"

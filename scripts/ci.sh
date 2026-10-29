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

echo "==> generated SDK compiles"
rm -rf .sdk-check
mkdir -p .sdk-check
npx --no-install tsx src/cli/sdk.ts ./mungil.config.ts ./.sdk-check/client.ts > /dev/null
npx --no-install tsc --noEmit --strict --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib ES2022,DOM ./.sdk-check/client.ts
rm -rf .sdk-check

echo
echo "PASS  local CI completed"

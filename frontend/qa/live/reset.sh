#!/usr/bin/env bash
# Fresh local D1/R2 + test tokens for live QA. Node 24 required.
# Then start:  (cd worker && node node_modules/wrangler/bin/wrangler.js dev --port 8799 --ip 127.0.0.1 --local --persist-to ../.verify/live/state)
#              (cd frontend && npx vite --config vite.qa-live.config.mjs)
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [ -d .verify/live/state ] || [ -f worker/.dev.vars ]; then
  printf '%s\n' 'Existing QA state or Worker environment found. Use a fresh isolated worktree; nothing was stopped or overwritten.' >&2
  exit 1
fi
mkdir -p .verify/live/state
node frontend/qa/live/mint.mjs
(cd worker && npx wrangler d1 migrations apply champbeam --local --persist-to ../.verify/live/state >/dev/null)
echo reset

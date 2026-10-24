#!/usr/bin/env bash
# Fresh local D1/R2 + tokens for live QA. Stops any wrangler dev on 8799. Node 24 required.
# Then start:  (cd worker && node node_modules/wrangler/bin/wrangler.js dev --port 8799 --ip 127.0.0.1 --local --persist-to ../.verify/live/state)
#              (cd frontend && npx vite --config vite.qa-live.config.mjs)
set -euo pipefail
cd "$(dirname "$0")/../../.."
pkill -f "wrangler.js dev --port 8799" || true; pkill -f workerd || true; sleep 2
rm -rf .verify/live/state; mkdir -p .verify/live/state
node frontend/qa/live/mint.mjs
(cd worker && npx wrangler d1 migrations apply champbeam --local --persist-to ../.verify/live/state >/dev/null)
echo reset

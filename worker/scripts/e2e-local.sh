#!/usr/bin/env bash
# Local end-to-end run: fresh local D1, build the SPA, start `wrangler dev`,
# mint a test user + API key, run scripts/e2e-smoke.mjs, stop the server.
#   cd worker && bash scripts/e2e-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
rm -rf .wrangler/state
npx wrangler d1 migrations apply champbeam --local >/dev/null
[ -f ../frontend/dist/index.html ] || npm --prefix ../frontend run build

USER_ID="$(node -e 'console.log(crypto.randomUUID())')"
RAW_KEY="cb_live_$(node -e 'console.log(crypto.randomUUID().replace(/-/g, ""))')"
KEY_HASH="$(node -e "console.log(require('crypto').createHash('sha256').update('$RAW_KEY').digest('hex'))")"
NOW="$(node -e 'console.log(new Date().toISOString())')"
npx wrangler d1 execute champbeam --local --command \
  "INSERT INTO users (id, clerk_id, email, is_active, created_at, updated_at) VALUES ('$USER_ID', 'user_e2e', 'e2e@example.com', 1, '$NOW', '$NOW');
   INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at) VALUES ('$(node -e 'console.log(crypto.randomUUID())')', '$USER_ID', 'e2e', '${RAW_KEY:0:12}', '$KEY_HASH', '$NOW');" >/dev/null

LOG="$(mktemp)"
npx wrangler dev --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do grep -q "Ready on" "$LOG" && break; sleep 1; done
grep -q "Ready on" "$LOG" || { cat "$LOG"; echo "wrangler dev did not start"; exit 1; }

node scripts/e2e-smoke.mjs "$BASE" "$RAW_KEY"

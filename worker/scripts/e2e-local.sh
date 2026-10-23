#!/usr/bin/env bash
# Local end-to-end run: fresh local D1, build the SPA if needed, start
# `wrangler dev`, mint a test user + API key, run scripts/e2e-smoke.mjs, then
# stop the server (whole process tree, including workerd).
#   cd worker && bash scripts/e2e-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"

[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
rm -rf .wrangler/state
npx wrangler d1 migrations apply champbeam --local >/dev/null
[ -f ../frontend/dist/index.html ] || npm --prefix ../frontend run build

uuid() { node -e 'console.log(crypto.randomUUID())'; }
USER_ID="$(uuid)"
RAW_KEY="cb_live_$(uuid | tr -d '-')"
KEY_HASH="$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$RAW_KEY")"
NOW="$(node -e 'console.log(new Date().toISOString())')"

# One statement per call: keep seeding failures loud.
d1() { npx wrangler d1 execute champbeam --local --command "$1" >/dev/null || { echo "seed failed: $1" >&2; exit 1; }; }
d1 "INSERT INTO users (id, clerk_id, email, is_active, created_at, updated_at) VALUES ('$USER_ID', 'user_e2e', 'e2e@example.com', 1, '$NOW', '$NOW')"
d1 "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at) VALUES ('$(uuid)', '$USER_ID', 'e2e', '${RAW_KEY:0:12}', '$KEY_HASH', '$NOW')"

LOG="$(mktemp)"
node node_modules/wrangler/bin/wrangler.js dev --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
stop_dev() {
  # On Windows (Git Bash) killing the bash-side PID leaves workerd running;
  # taskkill /T takes down the whole tree.
  if [ -r "/proc/$DEV_PID/winpid" ]; then
    taskkill //F //T //PID "$(cat "/proc/$DEV_PID/winpid")" >/dev/null 2>&1 || true
  else
    pkill -P "$DEV_PID" 2>/dev/null || true
    kill "$DEV_PID" 2>/dev/null || true
  fi
}
trap stop_dev EXIT

for _ in $(seq 1 90); do grep -q "Ready on" "$LOG" && break; sleep 1; done
grep -q "Ready on" "$LOG" || { cat "$LOG"; echo "wrangler dev did not start" >&2; exit 1; }

node scripts/e2e-smoke.mjs "$BASE" "$RAW_KEY"

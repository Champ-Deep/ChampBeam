#!/usr/bin/env bash
# ChampBeam BYOD provisioner — runs ON THE VPS HOST (where nginx/certbot live).
#
# Polls the backend's internal provisioning API for customer domains that
# passed DNS verification (status pending_ssl), provisions the nginx vhost +
# Let's Encrypt cert for each with the proven /root/deepify-add-domain.sh, and
# reports the result back. Installed as a systemd timer (see README.md).
#
# Config: /root/champbeam-provisioner.env (mode 600) must define:
#   PROVISIONER_TOKEN=<same value as the backend's PROVISIONER_TOKEN env>
# Optional overrides:
#   BACKEND_URL=https://champbeam-api.64.227.154.215.sslip.io  # nginx-served app host
#   ADD_DOMAIN_SCRIPT=/root/deepify-add-domain.sh
#   APP_NAME=app  APP_UUID_PREFIX=glqeabg3bi  APP_PORT=8000

set -euo pipefail

ENV_FILE="/root/champbeam-provisioner.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${PROVISIONER_TOKEN:?PROVISIONER_TOKEN not set (put it in $ENV_FILE)}"
BACKEND_URL="${BACKEND_URL:-https://champbeam-api.64.227.154.215.sslip.io}"
ADD_DOMAIN_SCRIPT="${ADD_DOMAIN_SCRIPT:-/root/deepify-add-domain.sh}"
APP_NAME="${APP_NAME:-app}"
APP_UUID_PREFIX="${APP_UUID_PREFIX:-glqeabg3bi}"
APP_PORT="${APP_PORT:-8000}"

API="$BACKEND_URL/api/v1/internal/provisioning"
AUTH=(-H "X-Provisioner-Token: $PROVISIONER_TOKEN")

jobs_json="$(curl -fsS --max-time 15 "${AUTH[@]}" "$API/domains")" || {
  echo "provisioner: backend unreachable at $API" >&2
  exit 0   # transient; the timer retries in a minute
}

count="$(echo "$jobs_json" | jq 'length')"
[ "$count" = "0" ] && exit 0

echo "$jobs_json" | jq -c '.[]' | while read -r job; do
  id="$(echo "$job" | jq -r '.id')"
  hostname="$(echo "$job" | jq -r '.hostname')"

  # Belt-and-braces hostname sanity check even though the backend validates.
  if ! echo "$hostname" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
    curl -fsS --max-time 15 "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d '{"ok": false, "error": "hostname failed provisioner sanity check"}' \
      "$API/domains/$id/result" >/dev/null || true
    continue
  fi

  # Never clobber a vhost this flow doesn't own (platform hosts, other apps).
  # deepify-add-domain.sh writes /etc/nginx/sites-available/<hostname>.conf and
  # registers the host in /root/app-domains.conf; a conf for this hostname that
  # exists WITHOUT that registration belongs to something else — skip it.
  existing_conf=""
  for f in "/etc/nginx/sites-enabled/$hostname" "/etc/nginx/sites-enabled/$hostname.conf"; do
    [ -e "$f" ] && existing_conf="$f"
  done
  if [ -n "$existing_conf" ] && ! grep -qs "^$APP_NAME $hostname\$" /root/app-domains.conf; then
    echo "provisioner: $hostname has a foreign vhost ($existing_conf); refusing" >&2
    curl -fsS --max-time 15 "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d '{"ok": false, "error": "hostname already has an nginx vhost not managed by ChampBeam"}' \
      "$API/domains/$id/result" >/dev/null || true
    continue
  fi

  echo "provisioner: provisioning $hostname"
  if out="$("$ADD_DOMAIN_SCRIPT" "$APP_NAME" "$hostname" "$APP_UUID_PREFIX" "$APP_PORT" 2>&1)"; then
    payload='{"ok": true}'
  else
    # Last 500 chars of output, JSON-escaped via jq.
    err="$(echo "$out" | tail -c 500 | jq -Rs .)"
    payload="{\"ok\": false, \"error\": $err}"
    echo "provisioner: $hostname FAILED: $out" >&2
  fi
  curl -fsS --max-time 15 "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d "$payload" "$API/domains/$id/result" >/dev/null || true
done

#!/usr/bin/env bash
# Liveness check of the deployed bot (D-032, D-049). Read-only: GET requests only.
#   bash scripts/monitor.sh                 # /health only
#   MAX_BOT_TOKEN=... bash scripts/monitor.sh  # also the webhook subscription in MAX
# Exit 0 — healthy; 1 — a problem (the message says which). Used by monitor.yml.
set -uo pipefail

base_url="${BASE_URL:-https://81-26-178-75.sslip.io}"
root="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

for attempt in 1 2 3; do
  if body=$(curl -fsS --max-time 20 "$base_url/health"); then
    echo "health: $body"
    echo "$body" | jq -e '.status == "ok" and (.queue.failed // 0) == 0' > /dev/null \
      || fail "/health is up but reports a problem"
    break
  fi
  [ "$attempt" -lt 3 ] || fail "$base_url/health is unreachable after 3 attempts"
  echo "attempt $attempt failed"; sleep 20
done

if [ -z "${MAX_BOT_TOKEN:-}" ]; then
  echo "SKIP: MAX_BOT_TOKEN is not set, subscription check skipped (#21)"
  exit 0
fi
# platform-api2.max.ru is issued by Russian Trusted Root CA, which many hosts do not trust.
urls=$(curl -fsS --max-time 20 --cacert "$root/certs/russian_trusted_root_ca.pem" \
  -H "Authorization: $MAX_BOT_TOKEN" https://platform-api2.max.ru/subscriptions \
  | jq -r '.subscriptions[].url') || fail "GET /subscriptions failed"
echo "subscriptions: $urls"
echo "$urls" | grep -qxF "$base_url/webhook" || fail "webhook subscription $base_url/webhook is missing"
echo "OK"

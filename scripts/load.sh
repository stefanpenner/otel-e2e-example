#!/usr/bin/env bash
# Generate traffic against the frontend so signals flow.
set -euo pipefail
URL="${1:-http://localhost:18080/}"
N="${2:-200}"
echo "sending $N requests to $URL"
for i in $(seq 1 "$N"); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || echo "000")
  printf '\r%4d/%d  last=%s' "$i" "$N" "$code"
  sleep 0.1
done
echo
echo "done."

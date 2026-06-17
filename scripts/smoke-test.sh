#!/usr/bin/env bash
# End-to-end check: drive traffic, then assert each signal landed in its backend.
# Exits non-zero on any failure.
set -uo pipefail

FRONTEND=http://localhost:18080
PROM=http://localhost:9090
TEMPO=http://localhost:3200
LOKI=http://localhost:3100

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }

wait_for() { # url name
  echo "waiting for $2 ..."
  for _ in $(seq 1 60); do
    curl -sf "$1" >/dev/null 2>&1 && { echo "  up: $2"; return 0; }
    sleep 2
  done
  echo "  TIMEOUT: $2 ($1)"; return 1
}

echo "== 1. wait for services =="
wait_for "$FRONTEND/healthz" frontend || exit 1
wait_for "$PROM/-/ready"     prometheus || exit 1
wait_for "$TEMPO/ready"      tempo || exit 1
wait_for "$LOKI/ready"       loki || exit 1

echo "== 2. generate traffic =="
for i in $(seq 1 60); do curl -s -o /dev/null "$FRONTEND/" || true; done
echo "  sent 60 requests; sleeping 12s for export/scrape ..."
sleep 12

echo "== 3. assert signals =="

# metrics: our custom counter should exist and be > 0
val=$(curl -sf "$PROM/api/v1/query" --data-urlencode 'query=sum(app_requests_total)' \
  | grep -o '"value":\[[^]]*\]' | grep -o '[0-9.]*"' | tr -d '"' | tail -1)
if [ -n "${val:-}" ] && awk "BEGIN{exit !($val>0)}"; then ok "metrics: app_requests_total=$val"; else bad "metrics: app_requests_total missing/zero"; fi

# traces: Tempo TraceQL search returns at least one trace for the frontend
n=$(curl -sf "$TEMPO/api/search" --data-urlencode 'q={resource.service.name="frontend"}' --data-urlencode 'limit=5' \
  -G | grep -o '"traceID"' | wc -l | tr -d ' ')
if [ "${n:-0}" -gt 0 ]; then ok "traces: found $n frontend trace(s)"; else bad "traces: none found"; fi

# logs: Loki returns log lines for the backend service
m=$(curl -sf -G "$LOKI/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="backend"}' --data-urlencode 'limit=5' \
  | grep -o '"values"' | wc -l | tr -d ' ')
if [ "${m:-0}" -gt 0 ]; then ok "logs: backend log stream present"; else bad "logs: none found"; fi

echo "== result: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]

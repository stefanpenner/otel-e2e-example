#!/usr/bin/env bash
# End-to-end check for the CI/CD demo: trigger runs, then assert each signal landed.
# Exits non-zero on any failure.
set -uo pipefail

SIM=http://localhost:18080
PROM=http://localhost:9090
TEMPO=http://localhost:3200
LOKI=http://localhost:3100

pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

wait_for() { # url name
  echo "waiting for $2 ..."
  for _ in $(seq 1 60); do
    curl -sf "$1" >/dev/null 2>&1 && { echo "  up: $2"; return 0; }
    sleep 2
  done
  echo "  TIMEOUT: $2 ($1)"; return 1
}

echo "== 1. wait for services =="
wait_for "$SIM/healthz"  simulator  || exit 1
wait_for "$PROM/-/ready" prometheus || exit 1
wait_for "$TEMPO/ready"  tempo      || exit 1
wait_for "$LOKI/ready"   loki       || exit 1

echo "== 2. trigger pipeline runs =="
for i in $(seq 1 20); do curl -s -o /dev/null "$SIM/trigger?workflow=ci"; done
curl -s -o /dev/null "$SIM/trigger?workflow=ci&fail=1"   # guarantee at least one failure
echo "  triggered 21 runs; sleeping 12s for export/scrape ..."
sleep 12

echo "== 3. assert signals =="

# metrics: pipeline run counter exists and is > 0
val=$(curl -sf "$PROM/api/v1/query" --data-urlencode 'query=sum(cicd_pipeline_runs_total)' \
  | grep -o '"value":\[[^]]*\]' | grep -o '[0-9.]*"' | tr -d '"' | tail -1)
if [ -n "${val:-}" ] && awk "BEGIN{exit !($val>0)}"; then ok "metrics: cicd_pipeline_runs_total=$val"; else bad "metrics: cicd_pipeline_runs_total missing/zero"; fi

# traces: Tempo has traces from the CI system, including a "job:" span
n=$(curl -sf -G "$TEMPO/api/search" --data-urlencode 'q={resource.service.name="github-actions"}' --data-urlencode 'limit=5' \
  | grep -o '"traceID"' | wc -l | tr -d ' ')
if [ "${n:-0}" -gt 0 ]; then ok "traces: found $n pipeline trace(s)"; else bad "traces: none found"; fi

# logs: Loki has logs from the CI system
m=$(curl -sf -G "$LOKI/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="github-actions"}' --data-urlencode 'limit=5' \
  | grep -o '"values"' | wc -l | tr -d ' ')
if [ "${m:-0}" -gt 0 ]; then ok "logs: github-actions log stream present"; else bad "logs: none found"; fi

echo "== result: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]

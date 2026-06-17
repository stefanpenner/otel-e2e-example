#!/usr/bin/env bash
# Trigger a burst of pipeline runs (on top of the ambient ones the simulator already fires).
set -euo pipefail
BASE="${1:-http://localhost:18080}"
N="${2:-20}"
WORKFLOWS=(ci ci ci deploy nightly)   # weighted toward CI
echo "triggering $N pipeline runs at $BASE"
for i in $(seq 1 "$N"); do
  wf=${WORKFLOWS[$((RANDOM % ${#WORKFLOWS[@]}))]}
  fail=""; [ $((RANDOM % 5)) -eq 0 ] && fail="&fail=1"   # force ~20% to fail
  res=$(curl -s "$BASE/trigger?workflow=$wf$fail" | grep -o '"result":"[a-z]*"' | cut -d'"' -f4 || echo "?")
  printf '\r%3d/%d  %-8s %s    ' "$i" "$N" "$wf" "$res"
done
echo; echo "done."

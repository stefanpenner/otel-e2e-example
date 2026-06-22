#!/usr/bin/env bash
# Run a *real* self-hosted GitHub Actions runner locally, exporting native OTel
# (PR actions/runner#4366) into this demo's collector.
#
# The runner emits OTLP/HTTP to {ACTIONS_RUNNER_OTLP_ENDPOINT}/v1/traces.
# We point that at the host-exposed collector (compose maps 4318 -> host 14318),
# so real job/step spans land in Tempo + Jaeger alongside the simulator's.
#
#   ./scripts/run-local-runner.sh                       # defaults below
#   REPO=owner/name RUNNER_DIR=/path/_layout ./scripts/run-local-runner.sh
#
# Enable mechanism (see OTelTraceExporter.cs in the PR):
#   _enabled       = ACTIONS_RUNNER_OTLP_ENDPOINT is set
#   _featureEnabled= server flag, DEFAULTS TO TRUE when absent (self-hosted/GHES)
#   => on github.com self-hosted, setting the endpoint is enough.
set -euo pipefail

REPO="${REPO:-stefanpenner/-ci-test}"
RUNNER_DIR="${RUNNER_DIR:-$HOME/src/stefanpenner-cs/runner/_layout}"
RUNNER_NAME="${RUNNER_NAME:-local-otel-runner}"
LABELS="${LABELS:-kind}"   # 'self-hosted' + OS/arch are added automatically
OTLP_ENDPOINT="${ACTIONS_RUNNER_OTLP_ENDPOINT:-http://localhost:14318}"

[ -x "$RUNNER_DIR/config.sh" ] || { echo "no runner at $RUNNER_DIR (build it first)"; exit 1; }
command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }

# Export the native-OTel knobs for the runner process (inherited by Runner.Worker).
export ACTIONS_RUNNER_OTLP_ENDPOINT="$OTLP_ENDPOINT"
export ACTIONS_RUNNER_OTLP_INSECURE="true"   # plain http to the local collector
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=demo,cicd.system=github-actions,service.name=github-actions-runner"

cd "$RUNNER_DIR"

if [ ! -f .runner ]; then
  echo "== registering runner against $REPO =="
  TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)
  ./config.sh --unattended --replace \
    --url "https://github.com/$REPO" \
    --token "$TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABELS"
else
  echo "== runner already configured ($(grep -o '\"agentName\":[^,]*' .runner 2>/dev/null || echo configured)) =="
fi

echo "== OTel export -> $ACTIONS_RUNNER_OTLP_ENDPOINT/v1/traces =="
echo "== starting runner (Ctrl-C to stop; ./config.sh remove --token <t> to unregister) =="
exec ./run.sh

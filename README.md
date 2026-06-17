# otel-e2e-example

**GitHub Actions, if it emitted full OpenTelemetry** — a fake CI/CD system, fully instrumented,
with the whole observability backend running on your laptop.

```
 simulator (fake GitHub Actions) ─► OTel Collector ─┬─► Tempo        traces
                                                     ├─► Prometheus   metrics
                                                     └─► Loki         logs
                                                              ▲
                                                              └──  Grafana  (dashboards + alerts)
```

A CI/CD pipeline is naturally trace-shaped — a run is a DAG of jobs and steps — so it's a
great thing to observe with OTel.

### How CI maps to OTel

| GitHub Actions concept | OTel signal | example |
|---|---|---|
| workflow run | **root span** (a whole trace) | `workflow: CI` |
| job (parallel within a layer) | **child span** | `job: test (node-20)` |
| step (sequential in a job) | **grandchild span** | `step: jest` |
| runner queue / pickup | span + `cicd_job_queue_ms` | |
| pass / fail | span status + `cicd_pipeline_runs_total{result}` | |
| step logs | **logs** with `trace_id` | links a log back to its run |

Attribute names follow OTel's CICD + VCS semantic conventions (`cicd.pipeline.*`, `vcs.*`).
The simulator fires runs on its own (~every 4s) and also on demand via an HTTP trigger.

---

## Prereqs

- Docker + Docker Compose, `curl`, `make` (optional)
- Free ports: 3000, 3100, 3200, 8889, 9090, 18080, 14317, 14318
  (collector OTLP is on host `14317`/`14318` to avoid clashing with other tools)

---

## Quick start

```bash
make up        # build + start everything   (first run pulls images, ~1–2 min)
make test      # trigger runs + assert all 3 signals landed
make load      # trigger a burst of pipeline runs (make load N=50)
make open      # open Grafana (http://localhost:3000)
```

`make up` == `docker compose up -d --build`. Tear down with `make down`, or `make clean` to wipe data.

---

# Part 1 — Emit → Visualize

### 1.1 Emit a pipeline run

It already runs ambient pipelines. To fire one yourself (like pushing a commit) — note it
returns the **trace_id**:

```bash
curl "localhost:18080/trigger?workflow=ci"
# {"runId":"4873","workflow":"CI","result":"success","durationMs":2838,"traceId":"4785f2...","repo":"acme/api","branch":"feature/login"}

curl "localhost:18080/trigger?workflow=ci&fail=1"   # force a failed run
curl "localhost:18080/trigger?workflow=deploy"      # try the deploy / nightly workflows
make load N=40                                       # a burst (some forced to fail)
```

How the emit is wired:

- `app/instrumentation.js` is loaded **before** the app (`node --require ./instrumentation.js app.js`).
  It starts the OTel SDK and wires all three signals (OTLP exporters for traces/metrics/logs +
  auto-instrumentation + winston→logs bridge).
- `app/app.js` is the CI engine. Each run opens a `workflow:` span; jobs (`Promise.all` per layer)
  open child spans in parallel; steps open sequential grandchild spans. It records
  `cicd_*` metrics and writes a winston log per step (with `trace_id`).
- `docker-compose.yml` env: `OTEL_EXPORTER_OTLP_ENDPOINT` (where) + `OTEL_SERVICE_NAME=github-actions` (who).

### 1.2 Visualize in Grafana → http://localhost:3000

(anonymous admin, no login)

**A) Dashboard** — left nav → **Dashboards → "CI/CD — Pipeline Health"**.
Runs/min by result, failure rate, pipeline p95 duration, job failures by job, runner queue p95, logs.

**B) A pipeline trace (Tempo)** — **Explore** (compass) → datasource **Tempo** → **Search**,
Service Name = `github-actions` → Run query → open a trace. You'll see:
- `workflow: CI` at the top
- `job: lint`, `job: test (node-18)`, `job: test (node-20)` **side by side** (parallel), then `job: build`
- steps nested under each job; a failed step is **red**, and it stops its job
- Or paste the `traceId` from a `/trigger` call: query type **TraceQL** isn't needed — use the
  **"Trace ID"** search and paste it.
- Click a span → **"Logs for this span"** → jumps to that run's logs in Loki.

**C) Logs (Loki)** — **Explore** → **Loki** → `{service_name="github-actions"}` → Run.
Each line has `workflow`, `job`, `step`, `run_id`, `trace_id`. The `trace_id` links back to the trace.

The loop: **failure-rate panel says *something broke* → trace says *which job/step* → log says *why*.**

---

# Part 2 — Use the tools

### 2.1 Prometheus — CI metrics → http://localhost:9090

```promql
sum by (result) (rate(cicd_pipeline_runs_total[5m])) * 60                       # runs/min, pass vs fail
sum(rate(cicd_pipeline_runs_total{result="failure"}[5m]))
  / sum(rate(cicd_pipeline_runs_total[5m]))                                     # failure rate (SLO signal)
histogram_quantile(0.95, sum by (le) (rate(cicd_pipeline_run_duration_ms_bucket[5m])))  # p95 build time
topk(3, sum by (job_name) (rate(cicd_jobs_total{result="failure"}[5m])))        # flakiest jobs
histogram_quantile(0.95, sum by (le) (rate(cicd_job_queue_ms_bucket[5m])))      # runner queue pressure
```

Targets healthy? **Status → Targets** (`otel-collector` job = `UP`).

### 2.2 Tempo — find pipeline runs by behavior (TraceQL)

Grafana **Explore → Tempo → TraceQL**:

```
{ resource.service.name = "github-actions" && status = error }       # failed runs
{ name = "job: build" && duration > 2s }                             # slow build jobs
{ span.vcs.ref.head.name = "main" && status = error }                # failures on main
{ span.cicd.pipeline.name = "Deploy" }                               # all deploy runs
```

### 2.3 Loki — search CI logs (LogQL)

Grafana **Explore → Loki**:

```
{service_name="github-actions"} | json | level="error"               # failed steps only
{service_name="github-actions"} | json | step="jest"                 # one step across runs
sum(rate({service_name="github-actions"} | json | level="error" [5m]))   # error-log rate
```

### 2.4 Alerting — page when CI is broken (Grafana UI)

1. **Alerting → Alert rules → New alert rule**.
2. Query A (Prometheus): pipeline failure rate
   ```promql
   sum(rate(cicd_pipeline_runs_total{result="failure"}[5m])) / sum(rate(cicd_pipeline_runs_total[5m]))
   ```
3. **Threshold** → `IS ABOVE 0.30` → set as alert condition.
4. Evaluate every `1m`. Save.
5. Force it to fire:
   ```bash
   for i in $(seq 1 30); do curl -s -o /dev/null "localhost:18080/trigger?workflow=ci&fail=1"; done
   ```
   Watch the rule flip to **Firing**.
6. Route it: **Alerting → Contact points** (Slack / webhook / PagerDuty) + **Notification policies**.

> Other real CI alerts to try: p95 build time regression, runner queue p95 too high, a specific
> job's failure rate.

---

## Layout

```
app/app.js               the fake CI/CD engine (workflows -> jobs -> steps as spans)
app/instrumentation.js   OTel SDK wiring: OTLP exporters for traces/metrics/logs
otel/collector-config.yaml   receive OTLP -> tempo / prometheus / loki
tempo/  prometheus/  loki/    backend configs
grafana/provisioning/        datasources + CI dashboard (auto-loaded)
scripts/load.sh              trigger a burst of runs
scripts/smoke-test.sh        e2e assertions (make test)
docker-compose.yml           the whole stack
```

## Troubleshooting

- **Empty panels?** Trigger runs (`make load`) and wait ~10s for export + scrape.
- **`make test` fails early?** Backends take a few seconds; re-run — it waits up to 2 min.
- **A metric label named `job` disappears:** Prometheus reserves `job` (= service name). Name CI
  job labels `job_name` instead (this repo does).
- **Reset everything:** `make clean && make up`.
- **Watch a service:** `docker compose logs -f simulator` (or `otel-collector`, `tempo`, ...).

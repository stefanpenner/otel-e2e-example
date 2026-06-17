# otel-e2e-example

A complete OpenTelemetry pipeline you can run on your laptop:

```
 frontend ─┐
 backend  ─┴─►  OTel Collector ─┬─►  Tempo        traces
                                ├─►  Prometheus   metrics
                                └─►  Loki         logs
                                          ▲
                                          └──  Grafana   (dashboards + alerts)
```

- **App** — two tiny Node/Express services. `frontend` calls `backend`. Instrumented **zero-code**
  via OTel auto-instrumentation (env-var configured), plus a few manual metrics + a manual span.
- **Collector** — one OTLP intake, fans out to three backends.
- **Backends** — Tempo (traces), Prometheus (metrics), Loki (logs).
- **Grafana** — one UI to view all three, linked by `trace_id`, plus alerting.

Everything is wired by `docker-compose.yml`. No code changes needed to follow along.

---

## Prereqs

- Docker + Docker Compose
- `curl`, `make` (optional but handy)
- Free ports: 3000, 3100, 3200, 8889, 9090, 18080, 14317, 14318
  (collector OTLP is published on host `14317`/`14318` to avoid clashing with other tools)

---

## Quick start

```bash
make up        # build + start everything   (first run pulls images, ~1–2 min)
make test      # generate traffic + assert all 3 signals landed
make load      # keep sending traffic so graphs move
make open      # open Grafana (http://localhost:3000)
```

`make up` == `docker compose up -d --build`. Tear down with `make down` (keep data) or
`make clean` (wipe trace/log volumes).

---

# Part 1 — Emit → Visualize

### 1.1 Emit (the app does this for you)

Hit the frontend. Each request makes a **trace** (frontend→backend), bumps **metrics**, and writes **logs**:

```bash
curl localhost:18080/         # {"ok":true,"backend":{...}}  (sometimes a 5xx — that's on purpose)
./scripts/load.sh http://localhost:18080/ 200   # or: make load N=200
```

How the emit is wired:

- `app/instrumentation.js` is loaded **before** the app (`node --require ./instrumentation.js app.js`).
  It starts the OTel SDK and wires all three signals: OTLP exporters for traces, metrics, and logs,
  plus `getNodeAutoInstrumentations()` (auto HTTP/Express/fetch spans + winston→logs bridge).
- `docker-compose.yml` env tells it *where* and *who*:
  - `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` — where to send
  - `OTEL_SERVICE_NAME=frontend|backend` — who is sending
  - `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=demo` — extra resource labels

Auto-instrumentation creates the HTTP/Express/fetch spans and propagates the trace across the
`frontend → backend` call. `app/app.js` adds a manual `compute` span and three custom metrics
(`app_requests`, `app_errors`, `app_work_duration_ms`). winston logs are auto-bridged to OTel logs
with the `trace_id` injected, which is what links a log line back to its trace.

> Want to emit **without the app**? The collector accepts OTLP straight from your host on
> `localhost:14318` (HTTP) / `localhost:14317` (gRPC). Any OTLP client (e.g. `otel-cli`) can push a span there.

### 1.2 Visualize in Grafana → http://localhost:3000

Open Grafana (anonymous admin, no login). Then:

**A) Dashboard (metrics)**
- Left nav → **Dashboards → "OTel E2E — RED + Logs"**.
- Four panels: request rate, error rate, backend p95 latency, live logs.
- Run `make load` and watch them move.

**B) Traces (Tempo)**
- **Explore** (compass icon) → datasource **Tempo** → query type **Search**.
- Service = `frontend`, Run query → click a trace.
- You'll see the waterfall: `GET /` (frontend) → `GET /work` (backend) → `compute` span.
- Click a span → **"Logs for this span"** → jumps to Loki filtered by that `trace_id`.

**C) Logs (Loki)**
- **Explore** → datasource **Loki** → query `{service_name="backend"}` → Run.
- Each line is JSON with a `trace_id`. The **TraceID** field links back to Tempo.

That's the loop: **metric tells you *something's wrong* → trace tells you *where* → log tells you *why*.**

---

# Part 2 — Use the tools

### 2.1 Prometheus — query metrics → http://localhost:9090

Paste into the expression bar (Graph tab):

```promql
sum by (role) (rate(app_requests_total[1m]))                                  # throughput
sum by (role) (rate(app_errors_total[1m]))                                    # errors
sum(rate(app_errors_total[5m])) / sum(rate(app_requests_total[5m]))           # error ratio (SLO signal)
histogram_quantile(0.95, sum by (le) (rate(app_work_duration_ms_bucket[5m]))) # p95 latency
```

Check targets are healthy: **Status → Targets** (the `otel-collector` job should be `UP`).

### 2.2 Tempo — find a trace by behavior (TraceQL)

In Grafana **Explore → Tempo → TraceQL**:

```
{ resource.service.name = "backend" && status = error }     # only failed requests
{ name = "compute" && span.work.sleep_ms > 150 }            # slow compute spans
{ duration > 200ms }                                        # slow traces
```

### 2.3 Loki — search logs (LogQL)

In Grafana **Explore → Loki**:

```
{service_name="backend"} | json | level="error"            # only errors
{service_name=~"frontend|backend"} |= "failed"             # text match
sum(rate({service_name="backend"} | json | level="error" [1m]))   # error log rate
```

### 2.4 Alerting — get told when it breaks (Grafana UI)

Create an alert on the error ratio:

1. Grafana → **Alerting → Alert rules → New alert rule**.
2. **Query A** (datasource Prometheus):
   ```promql
   sum(rate(app_errors_total[5m])) / sum(rate(app_requests_total[5m]))
   ```
3. **Expressions**: add a **Threshold** → `IS ABOVE 0.30` → set as the alert condition.
4. **Evaluation**: new folder + group, evaluate every `1m`, pending `0m`.
5. Save. To *force a fire*, raise the error rate and pour on traffic:
   ```bash
   docker compose exec -e ERROR_RATE=0.9 backend true   # (or set ERROR_RATE=0.9 in compose, then `make up`)
   make load N=300
   ```
   Watch **Alerting → Alert rules** flip to **Firing**.
6. Route it: **Alerting → Contact points** (Slack/webhook/email) + **Notification policies**.

> Prefer code? Drop a rule YAML in `grafana/provisioning/alerting/` and restart Grafana — same result, version-controlled.

---

## Layout

```
app/app.js               instrumented frontend+backend (one image, ROLE selects)
app/instrumentation.js   OTel SDK wiring: OTLP exporters for traces/metrics/logs
otel/collector-config.yaml   receive OTLP → tempo / prometheus / loki
tempo/  prometheus/  loki/    backend configs
grafana/provisioning/        datasources + dashboard (auto-loaded)
scripts/load.sh              traffic generator
scripts/smoke-test.sh        e2e assertions (make test)
docker-compose.yml           the whole stack
```

## Troubleshooting

- **Empty panels?** Send traffic (`make load`) and wait ~10s for export + scrape.
- **`make test` fails early?** Backends take a few seconds; re-run — it waits up to 2 min.
- **Reset everything:** `make clean && make up`.
- **What's a service doing?** `docker compose logs -f otel-collector` (or `frontend`, `tempo`, ...).

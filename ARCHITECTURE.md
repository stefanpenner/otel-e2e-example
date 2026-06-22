# Architecture — native OpenTelemetry for self-hosted GitHub Actions

Two ways to **emit** real CI/CD telemetry, one shared **backend** to store and view it.
A CI run is naturally trace-shaped (a DAG of jobs and steps), so it maps cleanly onto
OTel traces, metrics, and logs.

---

## Component map

```
                          GitHub Actions service (cloud)
                          + actions broker  (job queue / JIT config)
                           ▲ register / poll / acquire        ▲ register / poll / scale
                           │                                  │
     ┌─────────────────────┴──────────┐       ┌───────────────┴────────────────────┐
     │  LOCAL path (laptop)            │       │  CS path (kind k8s cluster)         │
     │                                 │       │                                     │
     │  self-hosted runner             │       │  ARC controller + listener          │
     │  actions/runner#4366            │       │  (actions-runner-controller#4465,   │
     │  native OTel, PAT-registered    │       │   instrumented ghalistener)         │
     │            │ OTLP/HTTP          │       │          │ scales 0..N              │
     │            │ /v1/traces         │       │          ▼                          │
     │            │                    │       │  ephemeral runner pod               │
     │            │                    │       │  otel-runner:dev (#4366, v2.335.1)  │
     │            │                    │       │          │ OTLP/HTTP                │
     └────────────┼────────────────────┘       └──────────┼──────────────────────────┘
                  │                                        │
                  ▼ host :14318                            ▼ otel-collector.observability:4318
        ┌──────────────────────┐                 ┌────────────────────────┐
        │  OTel Collector       │                 │  OTel Collector         │
        │  (host, compose)      │                 │  (in-cluster)           │
        └──┬──────┬──────┬──────┘                 └───────────┬─────────────┘
   traces ─┤      │      ├─ metrics → Prometheus :9090         │ traces
           │      │      └─ logs    → Loki :3100               ▼
           ▼      ▼                                      Tempo (in-cluster)
        Tempo   Jaeger ──────► Jaeger UI :16686
        :3200     │
           │      │
           ▼      ▼
        Grafana :3000   (datasources: Tempo · Jaeger · Prometheus · Loki)

   Terminal viewer (either store):
        ote --tempo=http://localhost:3200  --trace-id=<id>
        ote --jaeger=http://localhost:16686 --trace-id=<id>
```

The **simulator** (a fake CI engine) also emits to the host collector for ambient load;
the two paths above are the *real* instrumented runners.

---

## Key handshakes

### 1. OTel enablement — the opt-in
- The runner enables native export when **`ACTIONS_RUNNER_OTLP_ENDPOINT`** is set.
- The server-side feature flag **defaults to ON when absent**, so an operator's
  endpoint opt-in works on any self-hosted runner / GHES (no server change needed).
- Spans are POSTed as OTLP/HTTP to `{endpoint}/v1/traces`.
- Optional knobs: `ACTIONS_RUNNER_OTLP_HEADERS`, `_INSECURE`, `_PROPAGATE`
  (inject W3C `traceparent` into each step so in-job tools nest under the step span).

### 2. Runner ↔ GitHub registration
- **Local:** `config.sh` with a PAT registration token → persistent runner that
  listens for jobs (`run.sh`).
- **CS / k8s:** the ARC listener pulls a **JIT config** from the broker and creates a
  pod; the config arrives as env `ACTIONS_RUNNER_INPUT_JITCONFIG`, which the runner
  consumes as its `--jitconfig` arg → one job, then the pod exits (ephemeral).
- Version gate (learned the hard way): the JIT path enforces a **minimum runner
  version**. A too-old runner gets `AccessDenied` → **exit code 7**
  (`RunnerVersionDeprecated`), which ARC reads as "Outdated" and loops. Fix: build the
  runner reporting a current version (`RUNNER_VERSION_OVERRIDE=2.335.1`).

### 3. Collector fan-out
- **Host collector:** traces → **Tempo + Jaeger**, metrics → Prometheus (scrape),
  logs → Loki. One trace lands in *both* trace stores.
- **Cluster collector:** traces → in-cluster Tempo (+ debug exporter).

---

## Sequence — one CI run becomes a trace

```
1. push / workflow_dispatch              → GitHub queues a job
2. runner picks it up
     local:  persistent runner is listening
     cs:     listener scales an ephemeral pod that registers via JIT
3. runner opens the JOB span               "build-and-test"  (root)
4. for each step → a CHILD span            Set up job, Checkout, Build, Tests, …
5. each span → OTLP/HTTP → collector → trace store(s)
6. attributes attached on the way:
     cicd.pipeline.run.id / task.name / task.run.result / *.url   (CICD semconv)
     vcs.ref.head.* / vcs.change.id                               (VCS semconv)
     k8s.pod.name / k8s.namespace.name / k8s.node.name            (cs path, Downward API)
     service.name = github-actions-runner
7. (optional) job span LINKs to an inbound scheduler trace context (W3C)
8. view it: Grafana (Tempo/Jaeger), Jaeger UI, or `ote`
```

**Span tree (verified, both paths):**

```
test-runner / build-and-test          ← job (root span)
├─ Set up job
├─ Resolve actions/checkout@v4
├─ Checkout
├─ Build · Unit tests · Lint · …      ← step spans
└─ Complete job
```

---

## Where each piece lives

| Piece | Repo / PR | Role |
|---|---|---|
| Native OTel in the runner | [actions/runner#4366](https://github.com/actions/runner/pull/4366) | the **emitter** (runner/jobs/steps) |
| Instrumented ARC listener | [actions/actions-runner-controller#4465](https://github.com/actions/actions-runner-controller/pull/4465) | k8s **scaler** + its own OTel |
| Backend stack + both demos | this repo (`otel-e2e-example`) | Collector → Tempo/Jaeger/Prometheus/Loki → Grafana |
| Terminal viewer + ARC deploy | [stefanpenner/otel-explorer](https://github.com/stefanpenner/otel-explorer) | `ote` viewer; `examples/arc/` deploy |

See `README.md` Part 3 for running the real local runner, and the otel-explorer
`examples/arc/OTEL-RUNNER-STATUS.md` for the k8s/ARC deploy.

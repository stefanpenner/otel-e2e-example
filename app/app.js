// A fake CI/CD system — "GitHub Actions, if it emitted full OpenTelemetry".
//
// Each pipeline RUN becomes a trace:
//     workflow run (root span)
//       ├─ job: lint            (child span, runs in parallel with other jobs in its layer)
//       │   ├─ step: checkout   (grandchild span, sequential within the job)
//       │   ├─ step: npm ci
//       │   └─ step: eslint     (can fail -> fails the job -> fails the run)
//       └─ job: build (next layer, runs after the first layer passes)
//
// It also emits CI metrics (run/job counts, durations, queue wait) and per-step logs
// (with trace_id injected, so a log links back to its pipeline run).
//
// Two ways runs happen:
//   1. an ambient loop fires runs continuously (a busy CI server)
//   2. POST/GET /trigger?workflow=ci[&fail=1]  fires one on demand (like pushing a commit)
//      -> returns the run's trace_id so you can jump straight to it in Tempo.
//
// Attribute names follow OTel's CICD + VCS semantic conventions (cicd.*, vcs.*).

const express = require('express');
const winston = require('winston');
const {
  trace, context, metrics, SpanStatusCode, SpanKind, ROOT_CONTEXT,
} = require('@opentelemetry/api');

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERVAL = parseInt(process.env.PIPELINE_INTERVAL_MS || '4000', 10);
const FLAKY_RATE = parseFloat(process.env.FLAKY_RATE || '0.15');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

const tracer = trace.getTracer('cicd-sim');
const meter = metrics.getMeter('cicd-sim');
const runCounter = meter.createCounter('cicd_pipeline_runs', { description: 'pipeline runs' });
const jobCounter = meter.createCounter('cicd_jobs', { description: 'jobs executed' });
const runDur = meter.createHistogram('cicd_pipeline_run_duration_ms', { description: 'pipeline duration (ms)' });
const jobDur = meter.createHistogram('cicd_job_duration_ms', { description: 'job duration (ms)' });
const queueDur = meter.createHistogram('cicd_job_queue_ms', { description: 'runner queue wait (ms)' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const REPOS = ['acme/web', 'acme/api', 'acme/mobile'];
const BRANCHES = ['main', 'feature/login', 'fix/flaky-test', 'release/2.1'];
const ACTORS = ['alice', 'bob', 'carol', 'dependabot[bot]'];
const RUNNERS = ['ubuntu-latest-1', 'ubuntu-latest-2', 'self-hosted-gpu'];

// A workflow = ordered "layers". Jobs in the same layer run in parallel; layers run in sequence
// (this models GitHub Actions `needs:`). A failed layer fails the run and skips later layers.
const WORKFLOWS = {
  ci: {
    name: 'CI',
    layers: [
      [
        { job: 'lint', steps: ['checkout', 'setup-node', 'npm ci', 'eslint'] },
        { job: 'test (node-18)', steps: ['checkout', 'setup-node', 'npm ci', 'jest'] },
        { job: 'test (node-20)', steps: ['checkout', 'setup-node', 'npm ci', 'jest'] },
      ],
      [{ job: 'build', steps: ['checkout', 'setup-node', 'npm ci', 'npm run build', 'upload-artifact'] }],
    ],
  },
  deploy: {
    name: 'Deploy',
    layers: [
      [{ job: 'build', steps: ['checkout', 'docker build', 'push image'] }],
      [{ job: 'deploy-staging', steps: ['helm upgrade', 'smoke test'] }],
      [{ job: 'deploy-prod', steps: ['approval', 'helm upgrade', 'healthcheck'] }],
    ],
  },
  nightly: {
    name: 'Nightly E2E',
    layers: [[{ job: 'e2e', steps: ['checkout', 'setup', 'playwright install', 'playwright test'] }]],
  },
};

async function runStep(meta, jobName, step) {
  return tracer.startActiveSpan(`step: ${step}`, async (span) => {
    span.setAttribute('cicd.pipeline.task.name', step);
    const ms = rand(40, 350);
    await sleep(ms);
    // "flaky" steps (tests, lint, healthchecks) sometimes fail
    const flaky = /test|eslint|healthcheck|smoke/.test(step);
    if (flaky && Math.random() < FLAKY_RATE) {
      span.setAttribute('cicd.pipeline.result', 'failure');
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${step} failed` });
      span.end();
      logger.error('step failed', { workflow: meta.workflow, job: jobName, step, run_id: meta.runId, repo: meta.repo });
      return false;
    }
    span.setAttribute('cicd.pipeline.result', 'success');
    span.end();
    logger.info('step ok', { workflow: meta.workflow, job: jobName, step, run_id: meta.runId, duration_ms: ms });
    return true;
  });
}

async function runJob(wfKey, jobDef, parentCtx, meta) {
  return context.with(parentCtx, () =>
    tracer.startActiveSpan(`job: ${jobDef.job}`, { kind: SpanKind.INTERNAL }, async (span) => {
      span.setAttributes({
        'cicd.pipeline.name': meta.workflow,
        'cicd.pipeline.task.name': jobDef.job,
        'cicd.pipeline.run.id': meta.runId,
        'cicd.runner.name': pick(RUNNERS),
        'vcs.repository.name': meta.repo,
        'vcs.ref.head.name': meta.branch,
      });
      const queueMs = rand(50, 600);
      queueDur.record(queueMs, { workflow: wfKey });
      await sleep(queueMs); // runner pickup / queue wait

      const start = Date.now();
      let ok = true;
      for (const step of jobDef.steps) {
        if (!(await runStep(meta, jobDef.job, step))) { ok = false; break; }
      }
      const dur = Date.now() - start;
      const result = ok ? 'success' : 'failure';
      span.setAttribute('cicd.pipeline.result', result);
      span.setStatus({ code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end();
      // NB: use `job_name`, not `job` — Prometheus reserves the `job` label (= service name),
      // so a `job` metric attribute collides and the series gets dropped.
      jobDur.record(dur, { workflow: wfKey, job_name: jobDef.job, result });
      jobCounter.add(1, { workflow: wfKey, job_name: jobDef.job, result });
      return ok;
    }),
  );
}

async function runPipeline(wfKey, forced) {
  const wf = WORKFLOWS[wfKey] || WORKFLOWS.ci;
  const meta = {
    workflow: wf.name,
    runId: String(rand(1000, 9999)),
    repo: pick(REPOS),
    branch: pick(BRANCHES),
    actor: pick(ACTORS),
    event: pick(['push', 'pull_request', 'schedule']),
  };
  // ROOT_CONTEXT => every pipeline is its own clean trace (no HTTP parent for /trigger runs).
  return context.with(ROOT_CONTEXT, () =>
    tracer.startActiveSpan(`workflow: ${wf.name}`, { kind: SpanKind.SERVER }, async (root) => {
      const traceId = root.spanContext().traceId;
      root.setAttributes({
        'cicd.pipeline.name': wf.name,
        'cicd.pipeline.run.id': meta.runId,
        'cicd.pipeline.run.event': meta.event,
        'vcs.repository.name': meta.repo,
        'vcs.ref.head.name': meta.branch,
        'enduser.id': meta.actor,
      });
      logger.info('pipeline started', { workflow: wf.name, run_id: meta.runId, repo: meta.repo, branch: meta.branch });

      const start = Date.now();
      const ctx = trace.setSpan(context.active(), root); // jobs are children of the run
      let ok = true;
      for (const layer of wf.layers) {
        if (!ok) break; // a failed layer fails the run and skips later layers
        const results = await Promise.all(layer.map((jd) => runJob(wfKey, jd, ctx, meta)));
        if (results.some((r) => !r)) ok = false;
      }
      if (forced === 'fail') ok = false;

      const dur = Date.now() - start;
      const result = ok ? 'success' : 'failure';
      root.setAttribute('cicd.pipeline.result', result);
      root.setStatus({ code: ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      root.end();
      runDur.record(dur, { workflow: wfKey, result });
      runCounter.add(1, { workflow: wfKey, repo: meta.repo, result });
      const line = { workflow: wf.name, run_id: meta.runId, result, duration_ms: dur, trace_id: traceId };
      if (ok) logger.info('pipeline succeeded', line); else logger.error('pipeline failed', line);
      return { runId: meta.runId, workflow: wf.name, result, durationMs: dur, traceId, repo: meta.repo, branch: meta.branch };
    }),
  );
}

// ---- HTTP control plane (trigger runs on demand) ----
const app = express();
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'github-actions' }));
app.get('/', (req, res) =>
  res.json({
    service: 'github-actions (simulated)',
    workflows: Object.keys(WORKFLOWS),
    trigger: 'GET or POST /trigger?workflow=ci|deploy|nightly[&fail=1]',
  }));
app.all('/trigger', async (req, res) => {
  const out = await runPipeline(req.query.workflow, req.query.fail ? 'fail' : null);
  res.json(out);
});
app.listen(PORT, () => logger.info(`github-actions simulator listening on :${PORT}`));

// ---- ambient traffic: a busy CI server firing runs on its own ----
(async function loop() {
  for (;;) {
    runPipeline(pick(Object.keys(WORKFLOWS))).catch((e) => logger.error('run error', { err: String(e) }));
    await sleep(INTERVAL + rand(-1000, 1500));
  }
})();

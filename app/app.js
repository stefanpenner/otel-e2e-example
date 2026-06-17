// One image, two roles. ROLE=frontend serves "/", calls backend "/work".
// ROLE=backend serves "/work", does fake compute + random errors.
//
// Instrumentation is ZERO-CODE: started by `--require @opentelemetry/auto-instrumentations-node/register`
// (see package.json "start") and configured entirely by OTEL_* env vars in docker-compose.yml.
// Auto-instrumentation gives us http/express/fetch spans + W3C context propagation for free.
// Below we add a *little* manual signal (custom metrics + one child span) to show the manual API.

const express = require('express');
const winston = require('winston');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');

const ROLE = process.env.ROLE || 'frontend';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:8081';
const ERROR_RATE = parseFloat(process.env.ERROR_RATE || '0.15');

// winston logs are auto-bridged to OTel logs (trace_id injected) by instrumentation-winston.
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

// Manual metrics + a manual span, via the OTel API (no SDK wiring needed here).
const meter = metrics.getMeter('otel-e2e-example');
const reqCounter = meter.createCounter('app_requests', { description: 'requests handled' });
const errCounter = meter.createCounter('app_errors', { description: 'requests that failed' });
const workHist = meter.createHistogram('app_work_duration_ms', { description: 'work duration (ms)' });
const tracer = trace.getTracer('otel-e2e-example');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = express();

app.get('/healthz', (req, res) => res.json({ ok: true, role: ROLE }));

if (ROLE === 'backend') {
  app.get('/work', async (req, res) => {
    reqCounter.add(1, { role: ROLE, route: '/work' });
    const start = Date.now();
    await tracer.startActiveSpan('compute', async (span) => {
      const ms = 20 + Math.floor(Math.random() * 180);
      span.setAttribute('work.sleep_ms', ms);
      await sleep(ms);
      if (Math.random() < ERROR_RATE) {
        errCounter.add(1, { role: ROLE, route: '/work' });
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'compute failed' });
        span.end();
        logger.error('compute failed', { route: '/work', sleep_ms: ms });
        return res.status(500).json({ error: 'compute failed' });
      }
      span.end();
      const dur = Date.now() - start;
      workHist.record(dur, { role: ROLE });
      logger.info('work done', { route: '/work', sleep_ms: ms, duration_ms: dur });
      res.json({ ok: true, sleep_ms: ms });
    });
  });
} else {
  app.get('/', async (req, res) => {
    reqCounter.add(1, { role: ROLE, route: '/' });
    logger.info('handling request', { route: '/' });
    try {
      // global fetch is auto-instrumented -> traceparent header propagates the trace to backend.
      const r = await fetch(`${BACKEND_URL}/work`);
      const body = await r.json();
      if (!r.ok) {
        errCounter.add(1, { role: ROLE, route: '/' });
        logger.error('backend returned error', { status: r.status });
        return res.status(502).json({ error: 'backend error', backend: body });
      }
      res.json({ ok: true, backend: body });
    } catch (e) {
      errCounter.add(1, { role: ROLE, route: '/' });
      logger.error('request failed', { err: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });
}

app.listen(PORT, () => logger.info(`${ROLE} listening on :${PORT}`));

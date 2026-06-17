// Explicit OTel wiring — loaded via `node --require ./instrumentation.js` BEFORE app code.
//
// We wire all three signals here. (The shorthand `auto-instrumentations-node/register`
// only sets up traces in this SDK version, so we configure metrics + logs ourselves.)
//
// Config still comes from env (docker-compose.yml):
//   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_ENDPOINT
// The OTLP/HTTP exporters read OTEL_EXPORTER_OTLP_ENDPOINT and append /v1/{traces,metrics,logs}.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 5000,
  }),
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  instrumentations: [
    getNodeAutoInstrumentations({
      // bridge winston logs -> OTel logs (and inject trace_id into log records)
      '@opentelemetry/instrumentation-winston': { enabled: true },
    }),
  ],
});

sdk.start();

const shutdown = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

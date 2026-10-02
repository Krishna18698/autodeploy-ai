// Loaded with `node --import …/register` so instrumentation is in place
// before the app imports http/undici. Off unless an OTLP endpoint is set,
// e.g. Grafana Cloud: OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-…/otlp
// with OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic …".
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'autodeploy',
      [ATTR_SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Health probes and SSE keep-alives are noise in traces.
        ignoreIncomingRequestHook: (req) => /^\/(healthz|readyz|metrics)/.test(req.url ?? ''),
      }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  const shutdown = () => sdk.shutdown().catch(() => {});
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

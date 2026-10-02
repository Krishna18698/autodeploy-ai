import { randomBytes } from 'node:crypto';
import { context, propagation, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.token',
      '*.secret',
      '*.password',
    ],
    // Stamp every log line with the active trace so logs and traces join up.
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    ...(process.env.NODE_ENV === 'development' &&
      process.stdout.isTTY && { transport: { target: 'pino-pretty' } }),
  });
}

export const tracer = trace.getTracer('autodeploy');

/** W3C traceparent for the active context, or a fresh one when tracing is off. */
export function currentTraceparent(): string {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return (
    carrier.traceparent ??
    `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
  );
}

/**
 * Run `fn` in a span that continues the trace in `traceparent` — used to
 * stitch API request → queued job → worker → Kafka consumer into one trace.
 */
export async function withSpan<T>(
  name: string,
  traceparent: string | undefined,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = traceparent
    ? propagation.extract(context.active(), { traceparent })
    : context.active();
  return context.with(parent, () =>
    tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}

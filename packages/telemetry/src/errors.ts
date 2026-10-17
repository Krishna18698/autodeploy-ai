import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Error reporting to Sentry, by its envelope protocol over HTTP
// (https://develop.sentry.dev/sdk/data-model/envelopes/). Sentry's own Node SDK
// brings its own copies of OpenTelemetry and wants to own tracing, which this
// codebase already does; errors are all we send, so ~80 lines do the job.
//
// Without SENTRY_DSN nothing is sent. Sending never throws or blocks the
// caller, and a per-process budget keeps one crash loop from spending the
// free plan's monthly quota.

export type ErrorContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  /** 'node' for server errors, 'javascript' for errors reported by browsers. */
  platform?: 'node' | 'javascript';
};

type Dsn = { url: string; auth: string; raw: string };

export function parseDsn(dsn: string): Dsn | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !/^\d+$/.test(project)) return null;
    return {
      url: `${u.protocol}//${u.host}/api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=autodeploy/1.0`,
      raw: dsn,
    };
  } catch {
    return null;
  }
}

/** V8 stack lines → Sentry frames, oldest call first (Sentry's order). */
export function stackFrames(stack: string | undefined) {
  const frames = [];
  for (const line of (stack ?? '').split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (m)
      frames.push({
        function: m[1] ?? '?',
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
      });
  }
  return frames.reverse();
}

/** The envelope body for one error event. */
export function envelope(dsn: Dsn, service: string, err: unknown, ctx: ErrorContext = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const eventId = randomUUID().replaceAll('-', '');
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: ctx.platform ?? 'node',
    level: 'error',
    logger: service,
    server_name: hostname(),
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.GIT_SHA || undefined,
    tags: { service, ...ctx.tags },
    extra: ctx.extra,
    exception: {
      values: [{ type: e.name, value: e.message, stacktrace: { frames: stackFrames(e.stack) } }],
    },
  };
  return {
    eventId,
    body: `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.raw })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
  };
}

const BUDGET_PER_HOUR = 60;
let dsn: Dsn | null = null;
let service = 'autodeploy';
let windowStart = 0;
let sentInWindow = 0;

/** Call once at startup. Returns whether reporting is on. */
export function initErrorReporting(name: string, rawDsn = process.env.SENTRY_DSN): boolean {
  service = name;
  dsn = rawDsn ? parseDsn(rawDsn) : null;
  return dsn !== null;
}

/** Fire-and-forget: report an error that a person should look at. */
export function reportError(err: unknown, ctx?: ErrorContext): void {
  if (!dsn) return;
  const now = Date.now();
  if (now - windowStart > 3_600_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= BUDGET_PER_HOUR) return;
  sentInWindow++;
  const { body } = envelope(dsn, service, err, ctx);
  void fetch(dsn.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': dsn.auth },
    body,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

import { createServer, type Server } from 'node:http';

// A tiny Prometheus registry (counters, gauges, histograms) so the worker's
// behaviour is observable without pulling in a metrics library.

type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/"/g, '\\"')}"`)
    .join(',');

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render() {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values].map(([k, v]) => `${this.name}{${k}} ${v}`),
    ];
  }
}

class Gauge {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, v: number) {
    this.values.set(key(labels), v);
  }
  render() {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      ...[...this.values].map(([k, v]) => `${this.name}{${k}} ${v}`),
    ];
  }
}

class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, v: number) {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (v <= b) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
    });
    s.sum += v;
    s.count++;
    this.series.set(k, s);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      for (const [i, b] of this.bounds.entries()) {
        out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`);
      }
      out.push(
        `${this.name}_bucket{${sep}le="+Inf"} ${s.count}`,
        `${this.name}_sum{${k}} ${s.sum}`,
        `${this.name}_count{${k}} ${s.count}`,
      );
    }
    return out;
  }
}

export const metrics = {
  jobsClaimed: new Counter('autodeploy_jobs_claimed_total', 'Jobs claimed by this worker'),
  jobsFinished: new Counter('autodeploy_jobs_finished_total', 'Jobs finished, by outcome'),
  leaseLost: new Counter(
    'autodeploy_job_leases_lost_total',
    'Jobs abandoned because the lease was lost',
  ),
  leasesReaped: new Counter(
    'autodeploy_leases_reaped_total',
    'Expired leases requeued or dead-lettered by the reaper',
  ),
  queueDepth: new Gauge('autodeploy_queue_depth', 'Jobs by type and status'),
  oldestQueuedMs: new Gauge('autodeploy_queue_oldest_ms', 'Age of the oldest queued job'),
  buildSeconds: new Histogram(
    'autodeploy_build_duration_seconds',
    'Build attempt duration',
    [10, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900],
  ),
  recoveries: new Counter('autodeploy_recoveries_total', 'Recovery decisions by kind'),
  outboxPublished: new Counter(
    'autodeploy_outbox_published_total',
    'Outbox events published to Kafka',
  ),
  outboxBacklog: new Gauge('autodeploy_outbox_backlog', 'Unpublished outbox rows'),
  consumerLag: new Gauge('autodeploy_consumer_lag', 'Kafka consumer group lag'),
  consumed: new Counter('autodeploy_events_consumed_total', 'Events processed by consumer group'),
  aiCalls: new Counter('autodeploy_ai_calls_total', 'Model calls by provider and outcome'),
  breakerState: new Gauge('autodeploy_ai_breaker_open', '1 when a provider circuit is open'),
};

export function render(): string {
  return `${Object.values(metrics)
    .flatMap((m) => m.render())
    .join('\n')}\n`;
}

export function startMetricsServer(port: number, health: () => Promise<boolean>): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(render());
    } else if (req.url === '/healthz') {
      const ok = await health().catch(() => false);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded' }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
  return server;
}

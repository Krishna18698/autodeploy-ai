import { claim, complete, fail, heartbeat, type Job, NOTIFY_CHANNEL } from '@autodeploy/queue';
import type { Deps } from './deps.js';
import { metrics } from './metrics.js';

// Generic job runner. Each runner owns a set of job types and a number of
// concurrent slots. It wakes on Postgres NOTIFY (no hot polling), falls back
// to a slow poll, keeps leases alive with heartbeats, and turns a lost lease
// or a cancel request into an AbortSignal the handler must respect.

export type JobContext = {
  job: Job;
  signal: AbortSignal;
  workerId: string;
  /** Why the signal fired, if it did. */
  abortReason: () => 'canceled' | 'lease_lost' | 'shutdown' | null;
};

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export type Handler = (ctx: JobContext) => Promise<void>;

export type RunnerOptions = {
  name: string;
  handlers: Record<string, Handler>;
  concurrency: number;
  perOrgLimit?: number;
  pollMs?: number;
};

export class Runner {
  private active = 0;
  private stopping = false;
  private wake: (() => void) | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private loopDone: Promise<void> | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly o: RunnerOptions,
  ) {}

  async start(): Promise<void> {
    // LISTEN on a dedicated connection; any enqueue of our types wakes us.
    await this.deps.sql.listen(NOTIFY_CHANNEL, (type) => {
      if (type in this.o.handlers) this.wake?.();
    });
    this.loopDone = this.loop();
  }

  private async loop(): Promise<void> {
    const { env, log, sql } = this.deps;
    while (!this.stopping) {
      const free = this.o.concurrency - this.active;
      if (free > 0) {
        let jobs: Job[] = [];
        try {
          jobs = await claim(sql, {
            workerId: env.WORKER_ID,
            types: Object.keys(this.o.handlers),
            leaseMs: env.LEASE_MS,
            limit: free,
            ...(this.o.perOrgLimit !== undefined && { perOrgLimit: this.o.perOrgLimit }),
          });
        } catch (err) {
          log.error({ err, runner: this.o.name }, 'claim failed');
        }
        for (const job of jobs) this.spawn(job);
        if (jobs.length === free) continue; // there may be more ready work
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.pollMs ?? 5_000);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private spawn(job: Job) {
    metrics.jobsClaimed.inc({ type: job.type });
    this.active++;
    const p = this.run(job).finally(() => {
      this.active--;
      this.inflight.delete(p);
      this.wake?.();
    });
    this.inflight.add(p);
  }

  private async run(job: Job): Promise<void> {
    const { env, log, sql } = this.deps;
    const handler = this.o.handlers[job.type];
    if (!handler) return;
    const ac = new AbortController();
    this.controllers.add(ac);
    let reason: 'canceled' | 'lease_lost' | 'shutdown' | null = null;

    const beat = setInterval(
      async () => {
        try {
          const hb = await heartbeat(sql, job.id, env.WORKER_ID, env.LEASE_MS);
          if (!hb.ok) {
            reason = 'lease_lost';
            metrics.leaseLost.inc({ type: job.type });
            ac.abort();
          } else if (hb.cancelRequested && !reason) {
            reason = 'canceled';
            ac.abort();
          }
        } catch (err) {
          log.warn({ err, jobId: job.id }, 'heartbeat failed');
        }
      },
      Math.floor(env.LEASE_MS / 3),
    );

    const jlog = log.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    try {
      await handler({
        job,
        signal: ac.signal,
        workerId: env.WORKER_ID,
        abortReason: () => reason ?? (this.stopping && ac.signal.aborted ? 'shutdown' : null),
      });
      if (reason === 'lease_lost') {
        jlog.warn('finished after losing the lease; result discarded by the queue');
      } else {
        await complete(sql, job.id, env.WORKER_ID);
        metrics.jobsFinished.inc({
          type: job.type,
          outcome: reason === 'canceled' ? 'canceled' : 'done',
        });
      }
    } catch (err) {
      if (reason === 'lease_lost') {
        jlog.warn({ err }, 'job aborted: lease lost (another worker may own it now)');
      } else if (this.stopping && reason === null) {
        // Give the job back immediately instead of waiting for the lease to expire.
        await fail(sql, job, env.WORKER_ID, 'worker shutting down', { delayMs: 0 });
        metrics.jobsFinished.inc({ type: job.type, outcome: 'released' });
      } else {
        const permanent = err instanceof PermanentError;
        const outcome = await fail(sql, job, env.WORKER_ID, (err as Error).stack ?? String(err), {
          retryable: !permanent,
        });
        metrics.jobsFinished.inc({ type: job.type, outcome });
        jlog[outcome === 'dead' ? 'error' : 'warn']({ err, outcome }, 'job failed');
      }
    } finally {
      clearInterval(beat);
      this.controllers.delete(ac);
    }
  }

  /** Stop claiming, abort in-flight jobs (they release their leases), and wait. */
  async stop(graceMs = 20_000): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await Promise.race([Promise.all(this.inflight), new Promise((r) => setTimeout(r, graceMs))]);
    for (const ac of this.controllers) ac.abort();
    await Promise.allSettled(this.inflight);
    await this.loopDone;
  }
}

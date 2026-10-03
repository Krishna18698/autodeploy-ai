import type { Redactor } from '@autodeploy/core';
import { TOPICS } from '@autodeploy/db';
import { publish } from '@autodeploy/events';
import { CircuitBreaker, withTimeout } from '@autodeploy/resilience';
import { monotonicFactory } from 'ulid';
import type { Deps } from '../deps.js';

const ulid = monotonicFactory();

// Live log batches are best-effort: if Kafka is slow or down they are skipped
// (the full log still goes to object storage), and the breaker stops every
// build from waiting on a dead broker.
const liveLogs = new CircuitBreaker('live-logs', { failureThreshold: 3, cooldownMs: 30_000 });
const PUBLISH_EVERY_MS = 400;
const PUBLISH_MAX_LINES = 200;
const CHUNK_LINES = 1000;
const MAX_LINE = 4000;
const TAIL = 400;

export type LogContext = {
  orgId: string;
  projectId: string;
  deploymentId: string;
  attemptId: string;
  attemptNo: number;
};

/**
 * Receives build output line by line. Lines are redacted once, then:
 *   - batched to Kafka (build.logs) for the live view (realtime consumer → SSE),
 *   - persisted to object storage in 1000-line chunks for history,
 *   - and the last few hundred kept in memory for error classification.
 * Losing a live batch is tolerable (history is in S3); losing history isn't.
 */
export class LogSink {
  private seq = 0;
  private pending: Array<{ seq: number; text: string }> = [];
  private chunk: string[] = [];
  private chunkFirst = 0;
  private chunkSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  readonly tail: string[] = [];

  constructor(
    private readonly deps: Deps,
    private readonly ctx: LogContext,
    private readonly redact: Redactor,
  ) {}

  write(raw: string) {
    const text = this.redact(raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}…` : raw);
    const line = { seq: this.seq++, text };
    this.pending.push(line);
    this.chunk.push(text);
    this.tail.push(text);
    if (this.tail.length > TAIL) this.tail.shift();
    if (this.chunk.length >= CHUNK_LINES) this.queue(() => this.persistChunk());
    if (this.pending.length >= PUBLISH_MAX_LINES) this.queue(() => this.publishBatch());
    else if (!this.timer)
      this.timer = setTimeout(() => this.queue(() => this.publishBatch()), PUBLISH_EVERY_MS);
  }

  /** Marker lines the UI renders differently (stage headers). */
  stage(name: string) {
    this.write(`\u001b[36m▸ ${name}\u001b[0m`);
  }

  get lineCount() {
    return this.seq;
  }

  private queue(fn: () => Promise<void>) {
    this.flushing = this.flushing
      .then(fn)
      .catch((err) => this.deps.log.warn({ err }, 'log flush failed'));
  }

  private async publishBatch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    const event = {
      id: ulid(),
      type: 'build.log',
      occurredAt: new Date().toISOString(),
      orgId: this.ctx.orgId,
      projectId: this.ctx.projectId,
      deploymentId: this.ctx.deploymentId,
      data: { attemptNo: this.ctx.attemptNo, lines },
    };
    await liveLogs
      .exec(() =>
        withTimeout(2_000, () =>
          publish(this.deps.producer, [
            { topic: TOPICS.buildLogs, key: this.ctx.attemptId, value: JSON.stringify(event) },
          ]),
        ),
      )
      .catch(() => {}); // dropped live batch; history is persisted separately
  }

  private async persistChunk() {
    if (this.chunk.length === 0) return;
    const lines = this.chunk;
    const first = this.chunkFirst;
    const seq = this.chunkSeq++;
    this.chunk = [];
    this.chunkFirst = first + lines.length;
    const key = `logs/${this.ctx.attemptId}/${String(seq).padStart(5, '0')}.log`;
    const body = lines.join('\n');
    await this.deps.storage.put(key, body, 'text/plain; charset=utf-8');
    await this.deps
      .sql`insert into build_log_chunks (attempt_id, seq, first_line, line_count, bytes, storage_key)
      values (${this.ctx.attemptId}, ${seq}, ${first}, ${lines.length}, ${Buffer.byteLength(body)}, ${key})
      on conflict do nothing`;
  }

  /** Flush everything; call before marking the attempt finished. */
  async close() {
    this.queue(() => this.publishBatch());
    this.queue(() => this.persistChunk());
    await this.flushing;
  }
}

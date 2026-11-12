import type { OutgoingHttpHeaders } from 'node:http';
import type { Deployment } from '@autodeploy/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';

// Live deployment stream over Server-Sent Events.
//
// The realtime Kafka consumer (worker) appends status changes and log lines to
// a capped Valkey Stream per deployment. Each SSE client gets its own
// connection doing a blocking XREAD from the last id it saw, so a reconnect
// with Last-Event-ID resumes exactly where it stopped, with no gaps.

export const streamKey = (deploymentId: string) => `deploy:${deploymentId}`;
const HEARTBEAT_MS = 15_000;
const STREAM_ID = /^\d+-\d+$/;

type Sink = Pick<NodeJS.WritableStream, 'once' | 'removeListener'> & {
  writableLength: number;
  writableNeedDrain: boolean;
};
/** A reader this far behind, or stalled this long, is let go; it reconnects and resumes. */
export const SLOW_READER = { maxBufferedBytes: 1_000_000, stallMs: 30_000 };

/**
 * Whether the reader has caught up: at once if nothing is waiting, after its
 * 'drain' if output is buffered. False for one too far behind, stalled, or gone,
 * so the stream stops reading Valkey for it instead of buffering without limit.
 */
export function caughtUp(res: Sink, limits = SLOW_READER): Promise<boolean> {
  if (!res.writableNeedDrain) return Promise.resolve(true);
  if (res.writableLength > limits.maxBufferedBytes) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    const timer = setTimeout(() => done(false), limits.stallMs);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * How many live streams may be open at once: per person, and in all (per API
 * process). Each holds a dedicated Valkey connection, and anyone can sign in,
 * so without a limit one account could hold thousands open.
 */
export const STREAM_LIMITS = { perUser: 8, total: 300 };
const openByUser = new Map<string, number>();
let openTotal = 0;

/** A place for one more stream: its release (call once, when it ends), or null when full. */
export function admitStream(userId: string, limits = STREAM_LIMITS): (() => void) | null {
  const mine = openByUser.get(userId) ?? 0;
  if (mine >= limits.perUser || openTotal >= limits.total) return null;
  openByUser.set(userId, mine + 1);
  openTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openTotal--;
    const left = (openByUser.get(userId) ?? 1) - 1;
    if (left > 0) openByUser.set(userId, left);
    else openByUser.delete(userId);
  };
}

export async function streamDeployment(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  snapshot: Deployment,
  lastEventId?: string,
  /** Called once when the stream ends, however it ends. */
  onEnd: () => void = () => {},
) {
  // Headers already set on the reply (the dashboard's cross-origin permission
  // among them) would be dropped by writing to the raw response: carry them over.
  const set = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined),
  ) as OutgoingHttpHeaders;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...set,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // disable proxy buffering (nginx/Caddy)
    'x-request-id': req.id,
  });
  const send = (event: string, data: unknown, id?: string) => {
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.write('retry: 3000\n\n');
  send('snapshot', snapshot);

  const conn = deps.valkeyFactory();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    conn.disconnect();
    res.end();
    onEnd();
  };
  req.raw.on('close', close);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  let cursor = lastEventId && STREAM_ID.test(lastEventId) ? lastEventId : '0';
  try {
    while (!closed) {
      const result = (await conn.xread(
        'COUNT',
        500,
        'BLOCK',
        HEARTBEAT_MS,
        'STREAMS',
        streamKey(snapshot.id),
        cursor,
      )) as Array<[string, Array<[string, string[]]>]> | null;
      if (!result) continue;
      for (const [, entries] of result) {
        for (const [id, fields] of entries) {
          cursor = id;
          const kind = fields[1] ?? 'event';
          const data = fields[3] ?? '{}';
          // Batch log lines arrive as one entry; forward as-is (already JSON).
          res.write(`id: ${id}\nevent: ${kind}\ndata: ${data}\n\n`);
        }
      }
      // A slow reader: wait for it before reading more, and let it go if it
      // stalls or falls too far behind (it resumes from its Last-Event-ID).
      if (!(await caughtUp(res))) break;
    }
  } catch (err) {
    if (!closed) req.log.warn({ err }, 'deployment stream ended with an error');
  } finally {
    close();
  }
}

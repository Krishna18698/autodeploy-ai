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

export async function streamDeployment(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  snapshot: Deployment,
  lastEventId?: string,
) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
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
    }
  } catch (err) {
    if (!closed) req.log.warn({ err }, 'deployment stream ended with an error');
  } finally {
    close();
  }
}

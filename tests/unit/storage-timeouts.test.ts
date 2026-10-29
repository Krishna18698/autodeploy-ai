import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Storage } from '@autodeploy/storage';
import { afterAll, describe, expect, it } from 'vitest';

// Object storage that accepts a request and then says nothing (a connection it
// dropped without closing): a read gives up instead of waiting forever.

const seen: string[] = [];
const silent = createServer((req) => {
  seen.push(req.url ?? '');
  // Never answers.
});
await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
const port = (silent.address() as AddressInfo).port;
afterAll(() => {
  silent.closeAllConnections();
  silent.close();
});

describe('object storage that stops answering', () => {
  it('a read fails within its timeouts (retried first) instead of hanging', async () => {
    const storage = new Storage({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      timeouts: { connectMs: 500, idleMs: 300 },
    });
    const started = Date.now();
    await expect(storage.getText('logs/chunk-1.txt')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(seen.length).toBeGreaterThan(1); // it tried again before giving up
  });
});

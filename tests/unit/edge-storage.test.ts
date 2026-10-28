import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_RETRIES, storageReader } from '../../apps/edge/src/index';

// 2026-10-23: a just-deployed site's page took over 60 s to load from the test
// machine. One way that happens: Backblaze answering "busy" and aws4fetch's
// default of 10 retries with growing waits. Reads are now bounded.

const env = {
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_REGION: 'us-west-004',
  S3_ENDPOINT: 'https://s3.example',
  S3_BUCKET: 'bucket',
};
afterEach(() => vi.unstubAllGlobals());

describe('reading a site from storage', () => {
  it('a busy storage gets two more tries, then its answer is used', async () => {
    const f = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', f);
    const t0 = Date.now();
    const res = await storageReader(env, 'sites/abc')('index.html');
    expect(res.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1 + STORAGE_RETRIES);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const req = (f.mock.calls[0] as unknown as [Request])[0];
    expect(req.url).toBe('https://s3.example/bucket/sites/abc/index.html');
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('a storage that never answers is given up on in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (req: Request) =>
          new Promise((_, reject) =>
            req.signal.addEventListener('abort', () => reject(req.signal.reason)),
          ),
      ),
    );
    const t0 = Date.now();
    await expect(storageReader(env, 'sites/abc', 100)('index.html')).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

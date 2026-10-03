import {
  createRedactor,
  isValidSlug,
  parseSiteHost,
  routeKey,
  siteHost,
  slugify,
} from '@autodeploy/core';
import { decrypt, encrypt, parseKeyring, rewrap, safeEqual } from '@autodeploy/crypto';
import { backoffMs } from '@autodeploy/queue';
import {
  Bulkhead,
  BulkheadFullError,
  CircuitBreaker,
  CircuitOpenError,
  retry,
  withTimeout,
} from '@autodeploy/resilience';
import { describe, expect, it } from 'vitest';

describe('redaction', () => {
  it('removes known secret values and well-known token shapes', () => {
    const r = createRedactor(['hunter2-supersecret']);
    expect(r('password=hunter2-supersecret')).toBe('password=[redacted]');
    expect(r('token ghp_' + 'a'.repeat(36))).toBe('token [redacted]');
    expect(r('https://user:p4ssw0rd@registry.example.com')).toBe(
      'https://user:[redacted]@registry.example.com',
    );
    expect(r('adp_' + 'x'.repeat(30))).toBe('[redacted]');
    expect(r('nothing to see')).toBe('nothing to see');
  });
});

describe('site hostnames', () => {
  const D = 'autodeploy.eu.org';
  it('parses production, preview and pinned routes and refuses reserved labels', () => {
    expect(parseSiteHost(`shop.${D}`, D)).toEqual({ kind: 'production', slug: 'shop' });
    expect(parseSiteHost(`pr-42--shop.${D}:443`, D)).toEqual({
      kind: 'preview',
      slug: 'shop',
      pr: 42,
    });
    expect(parseSiteHost(`d128--shop.${D}`, D)).toEqual({
      kind: 'deployment',
      slug: 'shop',
      number: 128,
    });
    for (const bad of [`api.${D}`, `app.${D}`, `a.b.${D}`, `shop.other.org`, `-x.${D}`])
      expect(parseSiteHost(bad, D)).toBeUndefined();
  });
  it('round-trips hosts and builds KV keys', () => {
    for (const r of [
      { kind: 'production', slug: 'a' },
      { kind: 'preview', slug: 'a', pr: 1 },
      { kind: 'deployment', slug: 'a', number: 9 },
    ] as const) {
      expect(parseSiteHost(siteHost(r, D), D)).toEqual(r);
      expect(routeKey(r)).toMatch(/^route:/);
    }
  });
  it('slugifies and validates', () => {
    expect(slugify('My Cool_Site!!')).toBe('my-cool-site');
    expect(isValidSlug('api')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
  });
});

describe('envelope encryption', () => {
  const k1 = Buffer.alloc(32, 1).toString('base64');
  const k2 = Buffer.alloc(32, 2).toString('base64');
  it('round-trips, binds the context, and rotates by re-wrapping only the data key', () => {
    const ring1 = parseKeyring(`1:${k1}`);
    const env = encrypt(ring1, 's3cret', 'env:p:KEY');
    expect(decrypt(ring1, env, 'env:p:KEY')).toBe('s3cret');
    expect(() => decrypt(ring1, env, 'env:p:OTHER')).toThrow();
    const ring2 = parseKeyring(`1:${k1},2:${k2}`);
    const rotated = rewrap(ring2, env, 'env:p:KEY');
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.ciphertext.equals(env.ciphertext)).toBe(true);
    expect(decrypt(parseKeyring(`2:${k2}`), rotated, 'env:p:KEY')).toBe('s3cret');
  });
  it('rejects bad key material and compares in constant time', () => {
    expect(() => parseKeyring('1:short')).toThrow();
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('resilience', () => {
  it('opens the breaker after N failures, fails fast, then half-opens after the cooldown', async () => {
    let now = 0;
    const b = new CircuitBreaker('t', { failureThreshold: 2, cooldownMs: 1000, now: () => now });
    const boom = () => Promise.reject(new Error('x'));
    await expect(b.exec(boom)).rejects.toThrow('x');
    await expect(b.exec(boom)).rejects.toThrow('x');
    expect(b.state).toBe('open');
    await expect(b.exec(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);
    now = 1500;
    await expect(b.exec(() => Promise.resolve(1))).resolves.toBe(1);
    expect(b.state).toBe('closed');
  });
  it('retries only retryable errors', async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n++;
          if (n < 3) throw new Error('flaky');
          return 'ok';
        },
        { attempts: 3, baseMs: 1 },
      ),
    ).resolves.toBe('ok');
    let m = 0;
    await expect(
      retry(
        async () => {
          m++;
          throw new Error('fatal');
        },
        { attempts: 5, baseMs: 1, retryable: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(m).toBe(1);
  });
  it('times out and caps concurrency', async () => {
    await expect(withTimeout(20, () => new Promise((r) => setTimeout(r, 200)))).rejects.toThrow(
      'timed out',
    );
    const bh = new Bulkhead('b', 1, 0);
    const slow = bh.run(() => new Promise((r) => setTimeout(r, 30)));
    await expect(bh.run(async () => 1)).rejects.toBeInstanceOf(BulkheadFullError);
    await slow;
  });
  it('backs off exponentially with full jitter, capped', () => {
    expect(backoffMs(1, 1000, 60_000, () => 0.999)).toBeLessThan(1000);
    expect(backoffMs(4, 1000, 60_000, () => 0.999)).toBeLessThan(8000);
    expect(backoffMs(30, 1000, 60_000, () => 0.999)).toBeLessThan(60_000);
    expect(backoffMs(3, 1000, 60_000, () => 0)).toBe(0);
  });
});

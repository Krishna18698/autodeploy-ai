import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  envelope,
  initErrorReporting,
  parseDsn,
  reportError,
  stackFrames,
} from '../../packages/telemetry/src/errors';

describe('Sentry error reporting', () => {
  it('turns a DSN into the envelope endpoint and auth header', () => {
    const d = parseDsn('https://abc123@o42.ingest.us.sentry.io/4507');
    expect(d?.url).toBe('https://o42.ingest.us.sentry.io/api/4507/envelope/');
    expect(d?.auth).toContain('sentry_key=abc123');
    expect(parseDsn('not a dsn')).toBeNull();
    expect(parseDsn('https://o42.ingest.sentry.io/4507')).toBeNull(); // no key
  });

  it('orders stack frames oldest call first, as Sentry expects', () => {
    const frames = stackFrames(
      'Error: boom\n    at inner (/app/a.js:10:5)\n    at outer (/app/b.js:20:7)\n    at /app/c.js:30:1',
    );
    expect(frames.map((f) => f.function)).toEqual(['?', 'outer', 'inner']);
    expect(frames[2]).toMatchObject({ filename: '/app/a.js', lineno: 10, colno: 5 });
  });

  it('builds a three-line envelope: header, item header, event', () => {
    const d = parseDsn('https://k@sentry.example/1');
    if (!d) throw new Error('dsn');
    const { eventId, body } = envelope(d, 'api', new TypeError('bad'), { tags: { route: '/x' } });
    const [head, item, event, end] = body.split('\n');
    expect(JSON.parse(head ?? '')).toMatchObject({ event_id: eventId });
    expect(JSON.parse(item ?? '')).toEqual({ type: 'event' });
    expect(JSON.parse(event ?? '')).toMatchObject({
      level: 'error',
      tags: { service: 'api', route: '/x' },
      exception: { values: [{ type: 'TypeError', value: 'bad' }] },
    });
    expect(end).toBe('');
  });

  describe('sending', () => {
    const got: { url: string; auth: string; body: string }[] = [];
    let port = 0;
    const server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ url: req.url ?? '', auth: String(req.headers['x-sentry-auth']), body });
        res.end('{}');
      });
    });
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const settle = () => new Promise((r) => setTimeout(r, 150));

    it('sends nothing without a DSN', async () => {
      expect(initErrorReporting('test', '')).toBe(false);
      reportError(new Error('ignored'));
      await settle();
      expect(got).toHaveLength(0);
    });

    it('posts the error to the project envelope endpoint, and stops at the hourly budget', async () => {
      expect(initErrorReporting('test', `http://pubkey@127.0.0.1:${port}/7`)).toBe(true);
      reportError(new Error('first'));
      await settle();
      expect(got[0]?.url).toBe('/api/7/envelope/');
      expect(got[0]?.auth).toContain('sentry_key=pubkey');
      expect(got[0]?.body).toContain('"value":"first"');
      for (let i = 0; i < 100; i++) reportError(new Error(`spam ${i}`));
      await settle();
      expect(got.length).toBe(60);
    });
  });
});

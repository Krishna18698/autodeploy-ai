import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPrivateAddress, postPinned } from '../../apps/worker/src/jobs/integrations';

describe('outgoing webhooks never reach our own network', () => {
  it.each([
    ['10.0.0.5', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['172.18.0.3', true], // the Docker network
    ['100.64.0.1', true],
    ['::1', true],
    ['::ffff:10.0.0.1', true], // IPv4 wrapped in IPv6
    ['::ffff:127.0.0.1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::', true],
    ['93.184.216.34', false],
    ['2606:4700::6810:85e5', false],
  ])('%s private: %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it('connects to the address that was checked, whatever DNS would say later', async () => {
    const server = createServer((req, res) => {
      res.statusCode = req.headers.host?.startsWith('example.invalid') ? 204 : 500;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      // example.invalid never resolves: reaching the server proves the pin was used.
      const status = await postPinned(
        new URL(`http://example.invalid:${port}/hook`),
        { 'content-type': 'application/json' },
        '{}',
        { address: '127.0.0.1', family: 4 },
        AbortSignal.timeout(5000),
      );
      expect(status).toBe(204);
    } finally {
      server.close();
    }
  });
});

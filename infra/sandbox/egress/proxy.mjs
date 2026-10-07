// Forward proxy, the only exit from an internal Docker network.
//  - EGRESS_MODE=allowlist (builds): only the registries a build needs.
//  - EGRESS_MODE=public (SSR runtimes, ADR 0008): any public host on 80/443,
//    but never a private, loopback, link-local, CGNAT or metadata address
//    (SSRF guard). The name is resolved once and that checked IP is the one
//    connected to, so DNS rebinding can't swap it afterwards.
// Refusals are logged, which is also how we see what hostile code tried.
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect, isIP } from 'node:net';

const ALLOW = (
  process.env.EGRESS_ALLOW ??
  [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'repo.yarnpkg.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'github.com',
    'nodejs.org',
    // next/font/google downloads font files during `next build`.
    'fonts.googleapis.com',
    'fonts.gstatic.com',
  ].join(',')
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const PORT = Number(process.env.PORT ?? 3128);
const MODE = process.env.EGRESS_MODE === 'public' ? 'public' : 'allowlist';
const allowed = (host) => ALLOW.some((a) => host === a || host.endsWith(`.${a}`));

/** True for addresses an app must never reach through us. */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

/** The address to connect to, or null if the destination is refused. */
async function resolveAllowed(host, port) {
  if (MODE === 'allowlist') return allowed(host) && port === 443 ? host : null;
  if (port !== 443 && port !== 80) return null;
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) return null;
  return addrs[0].address;
}
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const server = createServer(async (req, res) => {
  // Plain-HTTP forward requests (absolute URI).
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('absolute URL required');
    return;
  }
  const port = Number(url.port || 80);
  const target =
    MODE === 'public'
      ? await resolveAllowed(url.hostname, port)
      : allowed(url.hostname)
        ? url.hostname
        : null;
  if (!target) {
    log({ action: 'deny', host: url.hostname, method: req.method });
    res.writeHead(403).end(`egress to ${url.hostname} is not allowed`);
    return;
  }
  const pin = MODE === 'public' ? { lookup: (_h, _o, cb) => cb(null, target, isIP(target)) } : {};
  const up = httpRequest(url, { method: req.method, headers: req.headers, ...pin }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
});

server.on('connect', async (req, clientSocket, head) => {
  const [host, portStr] = (req.url ?? '').split(':');
  const port = Number(portStr || 443);
  const target = host ? await resolveAllowed(host.toLowerCase(), port) : null;
  if (!target) {
    log({ action: 'deny', host, port });
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = connect(port, target, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const done = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', done);
  clientSocket.on('error', done);
  upstream.setTimeout(120_000, done);
});

if (process.env.EGRESS_NO_LISTEN !== '1')
  server.listen(PORT, () =>
    log({
      action: 'listening',
      port: PORT,
      mode: MODE,
      ...(MODE === 'allowlist' && { allow: ALLOW }),
    }),
  );

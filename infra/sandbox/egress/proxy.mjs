// Allowlisting forward proxy for the build sandbox. The sandbox network has
// no route to the internet; this proxy is the only exit, and it only tunnels
// to registries the build actually needs. Everything else is refused and
// logged, which is also how we see what a hostile build tried to reach.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const ALLOW = (
  process.env.EGRESS_ALLOW ??
  'registry.npmjs.org,registry.yarnpkg.com,repo.yarnpkg.com,codeload.github.com,objects.githubusercontent.com,github.com,nodejs.org'
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const PORT = Number(process.env.PORT ?? 3128);
const allowed = (host) => ALLOW.some((a) => host === a || host.endsWith(`.${a}`));
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const server = createServer((req, res) => {
  // Plain-HTTP forward requests (absolute URI).
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('absolute URL required');
    return;
  }
  if (!allowed(url.hostname)) {
    log({ action: 'deny', host: url.hostname, method: req.method });
    res.writeHead(403).end(`egress to ${url.hostname} is not allowed`);
    return;
  }
  const up = httpRequest(url, { method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = (req.url ?? '').split(':');
  const port = Number(portStr || 443);
  if (!host || !allowed(host.toLowerCase()) || port !== 443) {
    log({ action: 'deny', host, port });
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = connect(port, host, () => {
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

server.listen(PORT, () => log({ action: 'listening', port: PORT, allow: ALLOW }));

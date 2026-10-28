// A plain Node server: no framework, no build step; AutoDeploy runs `npm start`'s command.
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/echo') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: JSON.parse(body || '{}').message ?? null }));
    });
    return;
  }
  // Cookies, for the shared-domain checks: one only the server reads, one it
  // tries to share with the whole domain, and what it gets back.
  if (req.url === '/login') {
    const parent = (req.headers.host ?? '').split('.').slice(1).join('.');
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': ['sid=e2e; HttpOnly; Path=/; SameSite=Lax', `wide=1; Domain=${parent}; Path=/`],
    });
    res.end('{}');
    return;
  }
  if (req.url === '/cookies') {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>e2e node</title><h1>e2e node ok at ${new Date().toISOString()}</h1>`,
  );
}).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');

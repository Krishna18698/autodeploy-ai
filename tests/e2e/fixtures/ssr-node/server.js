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
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>e2e node</title><h1>e2e node ok at ${new Date().toISOString()}</h1>`,
  );
}).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0');

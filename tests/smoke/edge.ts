// Production edge smoke test: publishes a tiny site through the same code the
// worker uses (Storage → B2, CloudflareKvRouteStore → KV), checks it through
// the live Worker at https://smoke.<domain>, then always removes both.
//   pnpm tsx tests/smoke/edge.ts            (reads infra/deploy/.env.prod)
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareKvRouteStore } from '@autodeploy/db';
import { Storage } from '@autodeploy/storage';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = Object.fromEntries(
  (await readFile(join(root, 'infra/deploy/.env.prod'), 'utf8'))
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>;
const need = (k: string) => {
  const v = env[k];
  if (!v || v.startsWith('<FILL')) throw new Error(`${k} missing in .env.prod`);
  return v;
};
const domain = need('PLATFORM_DOMAIN');
const slug = 'smoke';
const base = `https://${slug}.${domain}`;
const marker = `autodeploy-smoke-${randomUUID().slice(0, 8)}`;

// The site: an SPA shell, a hashed asset, and the manifest the edge reads.
const dir = await mkdtemp(join(tmpdir(), 'ad-smoke-'));
const files: Record<string, string> = {
  'index.html': `<!doctype html><title>${marker}</title><script src="/assets/app.3f2a1b9c.js"></script><p>${marker}</p>`,
  'assets/app.3f2a1b9c.js': `console.log(${JSON.stringify(marker)});`,
};
const lines: string[] = [];
for (const [path, body] of Object.entries(files).sort()) {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), body);
  lines.push(`${path}\t${createHash('sha256').update(body).digest('hex')}\t${body.length}`);
}
const manifest = lines.join('\n');
const sha = createHash('sha256').update(manifest).digest('hex');
const prefix = `sites/${sha}`;

const storage = new Storage({
  endpoint: need('S3_ENDPOINT'),
  region: need('S3_REGION'),
  bucket: need('S3_BUCKET'),
  accessKeyId: need('S3_ACCESS_KEY_ID'),
  secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
});
const kv = new CloudflareKvRouteStore({
  accountId: need('CF_ACCOUNT_ID'),
  namespaceId: need('CF_KV_NAMESPACE_ID'),
  apiToken: need('CF_KV_API_TOKEN'),
});

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

try {
  await storage.uploadDir(dir, prefix, (rel) =>
    rel.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  );
  await storage.put(`${prefix}/.autodeploy-manifest.tsv`, manifest, 'text/tab-separated-values');
  await kv.put(`route:${slug}`, {
    deploymentId: randomUUID(),
    number: 1,
    artifactSha: sha,
    projectSlug: slug,
  });

  // KV is eventually consistent at the edge (up to ~60 s for a new key).
  const t0 = Date.now();
  let first: Response | undefined;
  while (Date.now() - t0 < 90_000) {
    first = await get('/');
    if (first.status === 200) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const html = first ? await first.text() : '';
  check(
    'route resolves via KV',
    first?.status === 200 && html.includes(marker),
    `HTTP ${first?.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  check(
    'index.html browser cache',
    first?.headers.get('cache-control') === 'public, max-age=0, must-revalidate',
    String(first?.headers.get('cache-control')),
  );
  check(
    'security headers',
    first?.headers.get('x-content-type-options') === 'nosniff' &&
      !!first?.headers.get('referrer-policy'),
    'nosniff + referrer-policy',
  );

  const asset = await get('/assets/app.3f2a1b9c.js');
  check(
    'hashed asset immutable',
    asset.status === 200 &&
      /immutable/.test(asset.headers.get('cache-control') ?? '') &&
      /javascript/.test(asset.headers.get('content-type') ?? ''),
    `${asset.status} ${asset.headers.get('content-type')} · ${asset.headers.get('cache-control')}`,
  );

  const spa = await get('/deep/client/route');
  check(
    'SPA fallback to index.html',
    spa.status === 200 && (await spa.text()).includes(marker),
    `HTTP ${spa.status}`,
  );

  const missing = await get('/missing.png');
  const manifestRes = await get('/.autodeploy-manifest.tsv');
  check(
    'missing file and manifest are 404',
    missing.status === 404 && manifestRes.status === 404,
    `${missing.status} / ${manifestRes.status}`,
  );

  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await (await get('/')).arrayBuffer();
    timings.push(Date.now() - t);
  }
  check('warm request latency (from this machine)', true, `${timings.join(', ')} ms`);
} finally {
  await kv.delete(`route:${slug}`).catch((e) => console.error('KV cleanup failed:', e));
  const removed = await storage.deletePrefix(prefix).catch((e) => {
    console.error('B2 cleanup failed:', e);
    return -1;
  });
  await rm(dir, { recursive: true, force: true });
  console.log(`cleanup: KV route deleted, ${removed} object(s) removed from B2`);
}

for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(40)} ${c.detail}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

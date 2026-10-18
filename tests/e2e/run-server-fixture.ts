// Local check, no Docker: analyze a built fixture with AutoDeploy's analyzer,
// then start it with the exact command and environment the runtime uses.
//   pnpm tsx tests/e2e/run-server-fixture.ts tests/e2e/fixtures/ssr-nuxt
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { analyze } from '@autodeploy/core';
import { readTree } from '@autodeploy/github';

const dir = resolve(process.argv[2] ?? '.');
const a = analyze(await readTree(dir));
console.log(
  `framework=${a.framework.value} mode=${a.mode.value} supported=${a.supported} build=${a.buildCommand.value}`,
  a.unsupportedReason ?? '',
);
console.log('server:', JSON.stringify(a.server?.value));
if (!a.server) process.exit(1);
const s = a.server.value;
const cwd = s.bundle === 'output-dir' ? join(dir, s.dir ?? '.output') : dir;
const port = 4600 + Math.floor(Math.random() * 300);
const child = spawn('sh', ['-c', `exec ${s.start}`], {
  cwd,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    PATH: `${join(cwd, 'node_modules/.bin')}:${process.env.PATH}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const t0 = Date.now();
let body = '';
for (;;) {
  const r = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
  if (r) {
    body = await r.text();
    console.log(`HTTP ${r.status} after ${Date.now() - t0} ms`);
    break;
  }
  if (child.exitCode !== null || Date.now() - t0 > 30000) {
    console.log('no answer; server log:', log.slice(-600));
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('page:', (/<h1[^>]*>([^<]*)/.exec(body)?.[1] ?? body.slice(0, 120)).trim());
child.kill('SIGTERM');

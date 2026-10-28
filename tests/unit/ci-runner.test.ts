import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_RUNNER_SOURCE, ciWorkflowVersion, ciWorkflowYaml } from '@autodeploy/github';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The script that runs in the user's GitHub Actions job, exactly as the
// workflow file embeds it, run here against a stand-in AutoDeploy API and a
// stand-in GitHub token service. Tiny parts (2 KiB) so splitting is exercised.
// The workflow embeds ci-runner.cjs as it is: CI_RUNNER_SOURCE must match it.

type Seen = {
  start: Record<string, string | undefined>[];
  log: string[];
  parts: Map<number, Buffer>;
  finish: { exitCode: number; parts: number; bytes: number }[];
};
let seen: Seen;
let refuseStart = false;
const body = (req: IncomingMessage) =>
  new Promise<Buffer>((r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks)));
  });
const api = createServer(async (req, res) => {
  const b = await body(req);
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/token') {
    const ok = req.headers.authorization === 'bearer request-token';
    res
      .writeHead(ok ? 200 : 401)
      .end(JSON.stringify({ value: `job-token-for-${url.searchParams.get('audience')}` }));
    return;
  }
  if (req.headers.authorization !== `Bearer job-token-for-http://127.0.0.1:${port()}`) {
    res.writeHead(401).end('no token');
    return;
  }
  if (url.pathname === '/ci/v1/start') {
    seen.start.push({
      attempt: req.headers['x-autodeploy-attempt'] as string,
      nonce: req.headers['x-autodeploy-nonce'] as string,
    });
    if (refuseStart) {
      res.writeHead(403).end('not this repository');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ env: { SECRET_KEY: 's3cret-value-123', MULTI: 'line-one\nline-two' } }),
    );
  } else if (url.pathname === '/ci/v1/log') {
    seen.log.push(...JSON.parse(b.toString()).lines);
    res.writeHead(204).end();
  } else if (url.pathname.startsWith('/ci/v1/parts/')) {
    seen.parts.set(Number(url.pathname.split('/').pop()), b);
    res.writeHead(204).end();
  } else if (url.pathname === '/ci/v1/finish') {
    seen.finish.push(JSON.parse(b.toString()));
    res.writeHead(204).end();
  } else res.writeHead(404).end();
});
const port = () => (api.address() as AddressInfo).port;
beforeAll(() => new Promise<void>((r) => api.listen(0, '127.0.0.1', r)));
afterAll(() => api.close());

/** The runner script, cut out of the workflow file the App commits. */
function runnerFromWorkflow(): string {
  const lines = ciWorkflowYaml().split('\n');
  const from = lines.findIndex((l) => l.includes("<<'AUTODEPLOY_RUNNER'"));
  const to = lines.findIndex((l, i) => i > from && l.trim() === 'AUTODEPLOY_RUNNER');
  return lines
    .slice(from + 1, to)
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n');
}

async function runJob(job: Record<string, unknown>, files: Record<string, string>) {
  seen = { start: [], log: [], parts: new Map(), finish: [] };
  const ws = await mkdtemp(join(tmpdir(), 'gh-workspace-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(ws, path, '..'), { recursive: true });
    await writeFile(join(ws, path), text);
  }
  const script = join(await mkdtemp(join(tmpdir(), 'runner-')), 'autodeploy.cjs');
  await writeFile(script, runnerFromWorkflow());
  const full = {
    v: 1,
    api: `http://127.0.0.1:${port()}`,
    attemptId: 'attempt-1',
    nonce: 'nonce-abc-123',
    sha: 'abc',
    node: 22,
    root: '.',
    env: { PUBLIC_FLAG: 'on' },
    keep: { deps: 'none' },
    label: 'test',
    partBytes: 2048,
    ...job,
  };
  return new Promise<{ code: number | null; stdout: string; ws: string }>((resolve) => {
    const p = spawn('node', [script], {
      env: {
        PATH: process.env.PATH,
        AUTODEPLOY_JOB: JSON.stringify(full),
        GITHUB_WORKSPACE: ws,
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port()}/token?x=1`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
      },
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code, stdout, ws }));
  });
}
/** The parts, joined in order, as a file list (and the files' text). */
async function unpack() {
  const n = seen.parts.size;
  const all = Buffer.concat(
    Array.from({ length: n }, (_, i) => seen.parts.get(i) ?? Buffer.alloc(0)),
  );
  const dir = await mkdtemp(join(tmpdir(), 'unpacked-'));
  await writeFile(join(dir, 'out.tgz'), all);
  const list = execFileSync('tar', ['-tzf', join(dir, 'out.tgz')], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''));
  execFileSync('tar', ['-xzf', join(dir, 'out.tgz'), '-C', dir]);
  return { list, dir };
}

const project = {
  'package.json': '{"name":"site"}',
  'src/page.txt': 'old text\n',
  'node_modules/dep/index.js': 'x',
  '.git/HEAD': 'ref: refs/heads/main',
  '.cache/junk': 'x',
  'big.bin': randomBytes(6000).toString('base64'), // so the output spans several 2 KiB parts
};
const patch = `--- a/src/page.txt\n+++ b/src/page.txt\n@@ -1 +1 @@\n-old text\n+repaired text\n`;

describe('the GitHub Actions runner, as committed to the repository', () => {
  it('claims the build, masks the variables, builds with them (never with its token), and sends the output in parts', async () => {
    const r = await runJob(
      {
        patch,
        script:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
          'set -e\necho "variable: ${SECRET_KEY:+present} public: $PUBLIC_FLAG"\necho "job token: ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-hidden} job: ${AUTODEPLOY_JOB:-hidden}"\nmkdir -p dist && cp src/page.txt dist/index.html\n',
      },
      project,
    );
    expect(r.code).toBe(0);
    expect(seen.start).toEqual([{ attempt: 'attempt-1', nonce: 'nonce-abc-123' }]);
    for (const masked of ['s3cret-value-123', 'line-one', 'line-two', 'nonce-abc-123'])
      expect(r.stdout).toContain(`::add-mask::${masked}`);
    expect(seen.log).toContain('variable: present public: on');
    expect(seen.log).toContain('job token: hidden job: hidden');
    expect(seen.parts.size).toBeGreaterThan(1);
    expect(seen.finish).toEqual([
      {
        exitCode: 0,
        parts: seen.parts.size,
        bytes: [...seen.parts.values()].reduce((s, b) => s + b.length, 0),
      },
    ]);
    const { list, dir } = await unpack();
    expect(list).toEqual(
      expect.arrayContaining(['dist/index.html', 'src/page.txt', 'package.json', 'big.bin']),
    );
    for (const gone of ['.git/HEAD', '.cache/junk', 'node_modules/dep/index.js'])
      expect(list).not.toContain(gone);
    expect(await readFile(join(dir, 'dist/index.html'), 'utf8')).toBe('repaired text\n');
  }, 30_000);

  it('a failing build reports its exit code and sends nothing', async () => {
    const r = await runJob({ script: 'echo "compiling"\nexit 3\n' }, project);
    expect(r.code).toBe(3);
    expect(seen.log).toContain('compiling');
    expect(seen.parts.size).toBe(0);
    expect(seen.finish).toEqual([{ exitCode: 3, parts: 0, bytes: 0 }]);
  }, 30_000);

  it('keeps node_modules only where told (a Next.js standalone server needs its own)', async () => {
    await runJob(
      { keep: { deps: 'under', path: '.next/standalone' }, script: 'true\n' },
      {
        ...project,
        '.next/standalone/node_modules/next/index.js': 'x',
        '.next/standalone/server.js': '',
      },
    );
    const { list } = await unpack();
    expect(list).toContain('.next/standalone/node_modules/next/index.js');
    expect(list).not.toContain('node_modules/dep/index.js');
  }, 30_000);

  it('stops before building when AutoDeploy refuses it', async () => {
    refuseStart = true;
    try {
      const r = await runJob({ script: 'echo "should not run"\n' }, project);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toContain('AutoDeploy refused start: 403');
      expect(seen.log).toEqual([]);
      expect(seen.finish).toEqual([]);
    } finally {
      refuseStart = false;
    }
  }, 30_000);

  it('embeds ci-runner.cjs exactly as written (regenerate with gen:ci-runner after editing it)', async () => {
    const file = await readFile(
      join(import.meta.dirname, '../../packages/github/src/ci-runner.cjs'),
      'utf8',
    );
    expect(CI_RUNNER_SOURCE).toBe(file);
    expect(runnerFromWorkflow()).toBe(file.trimEnd());
  });

  it('says which version it is, so an outdated copy can be updated', () => {
    expect(ciWorkflowVersion(ciWorkflowYaml())).toBe(1);
    expect(ciWorkflowVersion('name: something else')).toBe(0);
  });
});

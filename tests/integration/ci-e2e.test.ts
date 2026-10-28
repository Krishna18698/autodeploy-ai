import { spawn } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { type BuildConfig, ciKeys, ciPartKey } from '@autodeploy/core';
import { ciWorkflowYaml } from '@autodeploy/github';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GITHUB_OIDC_ISSUER } from '../../apps/api/src/lib/github-oidc';
import { GitHubActionsExecutor } from '../../apps/worker/src/executors/github-actions';
import type { LogSink } from '../../apps/worker/src/pipeline/logs';
import { makeDeployment, makeOrg, makeProject } from './helpers';

// A build on GitHub Actions end to end, with only GitHub stood in for: the
// worker's executor starts the "workflow" (the real runner script, run here),
// which talks to the real API routes over HTTP with job tokens signed by a
// stand-in for GitHub; the executor relays the log, fetches and checks the
// output, unpacks it and finds the built site.

const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...github.publicKey.export({ format: 'jwk' }), kid: 'gh-1' };
const stored = new Map<string, Buffer>();
const storage = {
  put: async (k: string, b: Buffer) => void stored.set(k, Buffer.from(b)),
  getStream: async (k: string) => {
    const b = stored.get(k);
    return b ? { body: Readable.from([b]) } : undefined;
  },
  deletePrefix: async (p: string) => {
    let n = 0;
    for (const k of [...stored.keys()]) if (k.startsWith(p)) n += Number(stored.delete(k));
    return n;
  },
};
let app: FastifyInstance;
let deps: Deps;
let api: string;
let tokens: string;
const tokenServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', kid: 'gh-1' });
  const body = b64({
    iss: GITHUB_OIDC_ISSUER,
    aud: url.searchParams.get('audience'),
    iat: now,
    exp: now + 300,
    repository: 'acme/gh-site',
    repository_id: '9',
    workflow_ref: 'acme/gh-site/.github/workflows/autodeploy.yml@refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '777',
  });
  const sig = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(github.privateKey)
    .toString('base64url');
  res.end(JSON.stringify({ value: `${head}.${body}.${sig}` }));
});

beforeAll(async () => {
  await new Promise<void>((r) => tokenServer.listen(0, '127.0.0.1', r));
  tokens = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token?x=1`;
  // The API on a real port: the runner speaks HTTP to it.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  api = `http://127.0.0.1:${port}`;
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_DOMAIN: 'autodeploy.test',
    API_PUBLIC_URL: api,
    DATABASE_URL: inject('databaseUrl'),
    VALKEY_URL: inject('valkeyUrl'),
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
    INTERNAL_TOKEN: 'internal-token-for-tests-123456',
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  (deps as { storage: unknown }).storage = storage;
  app = await buildApp(deps, { githubKeys: async (kid) => (kid === 'gh-1' ? jwk : null) });
  await app.listen({ port, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
  await deps.close();
  tokenServer.close();
});

const runnerScript = async () => {
  const lines = ciWorkflowYaml().split('\n');
  const from = lines.findIndex((l) => l.includes("<<'AUTODEPLOY_RUNNER'"));
  const to = lines.findIndex((l, i) => i > from && l.trim() === 'AUTODEPLOY_RUNNER');
  const file = join(await mkdtemp(join(tmpdir(), 'runner-')), 'autodeploy.cjs');
  await writeFile(
    file,
    lines
      .slice(from + 1, to)
      .map((l) => l.replace(/^ {10}/, ''))
      .join('\n'),
  );
  return file;
};

type Workflow = 'run' | ((job: { attemptId: string; nonce: string }) => Promise<void>);
async function build(o: {
  command: string;
  workflow?: Workflow;
  hasWorkflow?: boolean;
  abortAfterMs?: number;
}) {
  const org = await makeOrg(deps.sql);
  const p = await makeProject(deps.sql, org, {
    repo: 'acme/gh-site',
    slug: `gh-${randomUUID().slice(0, 8)}`,
  });
  const deploymentId = await makeDeployment(
    deps.sql,
    org,
    p.id,
    'BUILDING',
    Math.floor(Math.random() * 1e6),
  );
  const files = { 'package.json': '{"name":"site"}', 'src/page.txt': 'hello from the repo\n' };
  const checkout = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkout-'));
    for (const [f, t] of Object.entries(files)) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), t);
    }
    return dir;
  };
  // Real path: the executor resolves links (on a Mac, /var is /private/var).
  const srcDir = join(await realpath(await checkout()), 'src-root');
  await mkdir(srcDir);
  const ghWorkspace = await checkout();
  const cancelled: string[] = [];
  let runner: ReturnType<typeof spawn> | null = null;
  const script = await runnerScript();
  const gh = {
    fileText: async () => (o.hasWorkflow === false ? null : ciWorkflowYaml()),
    cancelRun: async (_r: unknown, runId: string) => {
      cancelled.push(runId);
      runner?.kill();
    },
    dispatchWorkflow: async (
      _r: unknown,
      _file: string,
      _ref: string,
      inputs: Record<string, string>,
    ) => {
      const job = JSON.parse(inputs.job ?? '{}');
      if (o.workflow && o.workflow !== 'run') {
        void o.workflow(job);
        return;
      }
      runner = spawn('node', [script], {
        env: {
          PATH: process.env.PATH,
          AUTODEPLOY_JOB: inputs.job,
          GITHUB_WORKSPACE: ghWorkspace,
          ACTIONS_ID_TOKEN_REQUEST_URL: tokens,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        },
        stdio: 'ignore',
      });
    },
  };
  const lines: string[] = [];
  const executor = new GitHubActionsExecutor(
    {
      env: {
        API_PUBLIC_URL: api,
        BUILD_TIMEOUT_S: 60,
        CI_MAX_OUTPUT_MB: 5,
        CI_MAX_UNPACKED_MB: 20,
        CI_START_TIMEOUT_S: 30,
      },
      valkey: deps.valkey,
      storage,
      github: gh,
      warn: () => {},
      pollMs: 100,
    },
    {
      repo: { owner: 'acme', repo: 'gh-site' },
      fullName: 'acme/gh-site',
      branch: 'main',
      sha: 'abc',
      deploymentId,
      projectId: p.id,
      orgId: org,
      label: 'test #1',
    },
  );
  const attemptId = randomUUID();
  const ctl = new AbortController();
  if (o.abortAfterMs) setTimeout(() => ctl.abort(), o.abortAfterMs);
  const result = await executor.execute({
    attemptId,
    srcDir,
    config: {
      nodeVersion: 22,
      installCommand: null,
      buildCommand: o.command,
      outputDir: 'dist',
      rootDir: '.',
      env: {},
      mode: 'static',
    } as BuildConfig,
    secrets: {},
    log: { write: (l: string) => void lines.push(l) } as unknown as LogSink,
    signal: ctl.signal,
  });
  return { result, lines, srcDir, attemptId, cancelled };
}

describe('a build on GitHub Actions, end to end (GitHub stood in for)', () => {
  it('builds there, relays the log, and unpacks the output where the sandbox would have left it', async () => {
    const { result, lines, srcDir, attemptId } = await build({
      command: 'echo "compiling on the runner"\nmkdir -p dist && cp src/page.txt dist/index.html',
    });
    expect(result).toMatchObject({ ok: true, outputDir: join(srcDir, 'dist') });
    expect(await readFile(join(srcDir, 'dist/index.html'), 'utf8')).toBe('hello from the repo\n');
    expect(lines).toContain('compiling on the runner');
    expect(lines.some((l) => l.includes('https://github.com/acme/gh-site/actions/runs/777'))).toBe(
      true,
    );
    // Nothing left behind: the attempt's keys and output parts are gone.
    expect(await deps.valkey.exists(ciKeys(attemptId).state, ciKeys(attemptId).done)).toBe(0);
    expect([...stored.keys()].filter((k) => k.includes(attemptId))).toEqual([]);
  }, 60_000);

  it("a failing build fails with the runner's exit code, and its log", async () => {
    const { result, lines } = await build({ command: 'echo "error TS2322: oops"\nexit 2' });
    expect(result).toMatchObject({ ok: false, reason: 'failed', exitCode: 2 });
    expect(lines).toContain('error TS2322: oops');
  }, 60_000);

  it('a cancelled deploy cancels the GitHub run', async () => {
    const { result, cancelled } = await build({ command: 'sleep 20', abortAfterMs: 2500 });
    expect(result).toMatchObject({ ok: false, reason: 'canceled' });
    expect(cancelled).toEqual(['777']);
  }, 60_000);

  it('says what to do when the workflow is not on the branch yet', async () => {
    const { result, lines } = await build({ command: 'true', hasWorkflow: false });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(lines[0]).toContain('merge the setup pull request');
  });

  // A workflow that sends a hand-made archive instead of a build (no file
  // system can hold these entries), straight into storage and Valkey, as the
  // API would have accepted it.
  type Entry = { name: string; type?: '0' | '1' | '2' | '5'; link?: string; data?: Buffer };
  const tarGz = (entries: Entry[]) => {
    const blocks: Buffer[] = [];
    for (const e of entries) {
      const data = e.data ?? Buffer.alloc(0);
      const h = Buffer.alloc(512);
      const field = (s: string, at: number, len: number) =>
        h.write(s.slice(0, len), at, len, 'utf8');
      field(e.name, 0, 100);
      field(e.type === '5' || e.type === '2' ? '0000755\0' : '0000644\0', 100, 8);
      field('0000000\0', 108, 8);
      field('0000000\0', 116, 8);
      field(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
      field(
        `${Math.floor(Date.now() / 1000)
          .toString(8)
          .padStart(11, '0')}\0`,
        136,
        12,
      );
      field('        ', 148, 8);
      field(e.type ?? '0', 156, 1);
      field(e.link ?? '', 157, 100);
      field('ustar\0', 257, 6);
      field('00', 263, 2);
      const sum = h.reduce((a, b) => a + b, 0);
      field(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
  };
  const sends = (entries: Entry[]) => async (job: { attemptId: string }) => {
    const tgz = tarGz(entries);
    stored.set(ciPartKey(job.attemptId, 0), tgz);
    await deps.valkey.set(ciKeys(job.attemptId).run, '777');
    await deps.valkey.set(
      ciKeys(job.attemptId).done,
      JSON.stringify({ exitCode: 0, parts: 1, bytes: tgz.length }),
    );
  };
  const site = { name: 'dist/index.html', data: Buffer.from('<h1>hi</h1>') };
  it.each([
    [
      'a path out of the checkout',
      [site, { name: '../escaped.txt', data: Buffer.from('x') }],
      'outside the checkout',
    ],
    [
      'a file through its own symlink',
      [
        site,
        { name: 'out', type: '2', link: '/tmp' },
        { name: 'out/planted.txt', data: Buffer.from('x') },
      ],
      'through a symlink',
    ],
    [
      'a hard link',
      [site, { name: 'h', type: '1', link: 'dist/index.html' }],
      'other than files, folders and symlinks',
    ],
    [
      'that would unpack past the cap (a compressed bomb)',
      [site, { name: 'zeros.bin', data: Buffer.alloc(25 * 1024 * 1024) }],
      'unpacks to more than 20 MB',
    ],
  ] as [string, Entry[], string][])(
    'refuses an output with %s, and unpacks none of it',
    async (_why, entries, message) => {
      const { result, lines, srcDir } = await build({ command: 'true', workflow: sends(entries) });
      expect(result).toMatchObject({ ok: false, reason: 'failed' });
      expect(lines.at(-1)).toContain(message);
      await expect(readFile(join(srcDir, 'dist/index.html'))).rejects.toThrow();
    },
    60_000,
  );

  it('accepts a well-formed hand-made output (the checks above refuse only what they should)', async () => {
    const { result, srcDir, lines } = await build({
      command: 'true',
      workflow: sends([
        { name: 'dist', type: '5' },
        site,
        { name: 'dist/latest', type: '2', link: 'index.html' },
      ]),
    });
    expect(result, lines.join('\n')).toMatchObject({ ok: true });
    expect(await readFile(join(srcDir, 'dist/index.html'), 'utf8')).toBe('<h1>hi</h1>');
  }, 60_000);
});

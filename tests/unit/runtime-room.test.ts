import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keyring } from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';
import type { Storage } from '@autodeploy/storage';
import type { Logger } from '@autodeploy/telemetry';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env } from '../../apps/worker/src/env';
import { proxyToApp } from '../../apps/worker/src/gateway/proxy';
import {
  availableMemoryMb,
  type Instance,
  mib,
  primeBundle,
  RuntimeManager,
} from '../../apps/worker/src/gateway/runtimes';

// Server-rendered sites wake on demand (ADR 0008). These run the real
// RuntimeManager against a stand-in `docker` and one local web server that
// answers for every "container", with the VM's free memory under the test's
// control: each awake server takes PER_SERVER of it.

const site = createServer((_req, res) => res.end('ok'));
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const port = (site.address() as AddressInfo).port;
const bin = await mkdtemp(join(tmpdir(), 'fake-docker-'));
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh
case "$*" in *--cgroup-parent*) [ -f "${bin}/refuse-cgroup" ] && { echo "cgroup refused" >&2; exit 125; } ;; esac
case "$1" in
  run) echo container-id ;;
  port) echo "0.0.0.0:${port}" ;;
  inspect) for n; do :; done
    [ -f "${bin}/gone-$n" ] && { echo "Error: No such object: $n" >&2; exit 1; }
    [ -f "${bin}/dead-$n" ] && { echo "false true 137"; exit 0; }
    echo true ;;
esac
exit 0
`,
);
await chmod(join(bin, 'docker'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath}`;
const bundles = await mkdtemp(join(tmpdir(), 'bundles-'));
await mkdir(join(bundles, 'sha1'));
afterAll(() => {
  process.env.PATH = realPath;
  site.close();
});

const PER_SERVER = 200;
const CAP = 256;
const RESERVE = 4096;
/** Free memory with `n` servers awake, given what's free with none. */
const freeWith = (base: number) => (n: number) => base - PER_SERVER * n;

/**
 * A stand-in database: every deployment is a live server-rendered one, unless
 * the test deleted it; `liveShas` are the bundles of projects' live deployments.
 */
function fakeSql(db: {
  deleted: Set<string>;
  liveShas: string[];
  forks: Set<string>;
  secretReads: string[];
  records: Record<string, unknown>[];
}) {
  return ((first: unknown, ...values: unknown[]) => {
    if (!Array.isArray(first)) return first; // the sql(row) helper
    const text = (first as string[]).join('?');
    if (text.includes('insert into runtime_instances')) {
      const row = values[0] as { deployment_id: string };
      db.records.push(row);
      return db.deleted.has(row.deployment_id)
        ? Promise.reject(Object.assign(new Error('foreign key violation'), { code: '23503' }))
        : Promise.resolve([]);
    }
    if (text.includes('select id, status from deployments')) {
      const ids = values[0] as string[];
      return Promise.resolve(
        ids.filter((id) => !db.deleted.has(id)).map((id) => ({ id, status: 'ACTIVE' })),
      );
    }
    if (text.includes('active_deployment_id')) {
      return Promise.resolve(db.liveShas.map((sha) => ({ sha })));
    }
    if (text.includes('from env_vars')) {
      db.secretReads.push(String(values[0]));
      return Promise.resolve([]);
    }
    if (text.includes('from deployments where id')) {
      return Promise.resolve([
        {
          org_id: 'org',
          from_fork: db.forks.has(String(values[0])),
          project_id: 'project',
          status: 'ACTIVE',
          mode: 'ssr',
          runtime_sha: 'sha1',
          runtime_node: 22,
          runtime_command: null,
          runtime_workdir: null,
        },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
}

function setup(o: {
  maxAwake?: number;
  free: ((awake: number) => number) | null;
  bundlesDir?: string;
  liveShas?: string[];
  cgroupParent?: string;
}) {
  const db = {
    deleted: new Set<string>(),
    liveShas: o.liveShas ?? [],
    forks: new Set<string>(),
    secretReads: [] as string[],
    records: [] as Record<string, unknown>[],
  };
  const sql = fakeSql(db);
  const stopped: { id: string; reason: string }[] = [];
  const warnings: string[] = [];
  const log = {
    info: (f: { deploymentId?: string; reason?: string }) => {
      if (f.reason && f.deploymentId) stopped.push({ id: f.deploymentId, reason: f.reason });
    },
    warn: (_f: unknown, msg: string) => warnings.push(msg),
    debug() {},
    error() {},
  } as unknown as Logger;
  const env = {
    SANDBOX_RUNTIME: 'runc',
    SANDBOX_IMAGE_PREFIX: 'node:',
    RUNTIME_REACH: 'publish',
    RUNTIME_NETWORK: 'n',
    RUNTIME_PROXY: 'http://proxy:3129',
    RUNTIME_BUNDLES_DIR: o.bundlesDir ?? bundles,
    RUNTIME_BUNDLE_KEEP_H: 24,
    RUNTIME_CGROUP_PARENT: o.cgroupParent ?? '',
    RUNTIME_MEMORY: `${CAP}m`,
    RUNTIME_CPUS: '0.5',
    RUNTIME_IDLE_MIN: 15,
    RUNTIME_MAX_AWAKE: o.maxAwake ?? 20,
    RUNTIME_MIN_FREE_MB: RESERVE,
    RUNTIME_START_TIMEOUT_S: 5,
  } as unknown as Env;
  const free = o.free;
  const mgr: RuntimeManager = new RuntimeManager({
    env,
    sql,
    storage: {} as Storage,
    keyring: {} as Keyring,
    log,
    freeMemoryMb: async () => (free ? free(mgr.awake) : null),
  });
  /** Wakes each site in turn, the first one used longest ago. */
  const wake = async (...ids: string[]) => {
    const out: Instance[] = [];
    for (const [i, id] of ids.entries()) {
      const inst = await mgr.ensure(id);
      inst.lastRequest = 1_000 + i;
      out.push(inst);
    }
    return out;
  };
  return { mgr, stopped, warnings, wake, db };
}

describe('waking a server-rendered site never squeezes the VM', () => {
  // Room for three servers: with three awake, less than the reserve plus one cap is free.
  const roomForThree = freeWith(RESERVE + CAP + 2 * PER_SERVER + 50);

  it('wakes servers while memory allows, then puts the longest-idle one to sleep first', async () => {
    const { mgr, stopped, wake } = setup({ free: roomForThree });
    const [a, b] = await wake('a', 'b', 'c');
    expect(mgr.awake).toBe(3);
    b!.lastRequest = 500; // b now unused the longest
    a!.lastRequest = 2_000;
    await mgr.ensure('d');
    expect(stopped).toEqual([{ id: 'b', reason: expect.stringMatching(/low memory/) }]);
    expect(mgr.awake).toBe(3);
  });

  it('refuses (503) rather than squeeze the VM when every awake server is mid-request', async () => {
    const { mgr, stopped, wake } = setup({ free: roomForThree });
    const awake = await wake('a', 'b', 'c');
    for (const i of awake) i.active = 1;
    await expect(mgr.ensure('d')).rejects.toMatchObject({ status: 503 });
    expect(stopped).toEqual([]);
    expect(mgr.awake).toBe(3);
    // One finishes its request: now it can make way.
    awake[1]!.active = 0;
    await mgr.ensure('d');
    expect(stopped.map((s) => s.id)).toEqual(['b']);
  });

  it('counts the memory of wakes still starting, so a burst of them cannot all fit in the same space', async () => {
    const { mgr } = setup({ free: freeWith(RESERVE + CAP + CAP + 100) }); // room for two
    const results = await Promise.allSettled(['a', 'b', 'c'].map((id) => mgr.ensure(id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 503 },
    });
  });

  it('at the awake limit the longest-idle one goes; where memory cannot be read (off Linux), that limit alone applies', async () => {
    const { mgr, stopped, wake } = setup({ maxAwake: 2, free: null });
    await wake('a', 'b');
    await mgr.ensure('c');
    expect(stopped).toEqual([{ id: 'a', reason: 'evicted (awake limit)' }]);
    expect(mgr.awake).toBe(2);
  });

  it('puts idle servers to sleep when memory runs low after they woke (a build started), never one mid-request', async () => {
    let base = 100_000;
    const { mgr, stopped, wake } = setup({ free: (n) => base - PER_SERVER * n });
    const [, , c] = await wake('a', 'b', 'c');
    c!.active = 1;
    // Below half the reserve with three awake; one fewer is enough.
    base = RESERVE / 2 + 2 * PER_SERVER + 50;
    await mgr.reapIdle(2_000);
    expect(stopped.map((s) => s.id)).toEqual(['a']);
    // Much lower: every idle one sleeps, the busy one stays.
    base = 1_000;
    await mgr.reapIdle(2_000);
    expect(stopped.map((s) => s.id)).toEqual(['a', 'b']);
    expect(mgr.awake).toBe(1);
  });

  it('puts a server to sleep after RUNTIME_IDLE_MIN (15) minutes without visitors', async () => {
    const { mgr, stopped, wake } = setup({ free: freeWith(100_000) });
    await wake('a', 'b');
    await mgr.reapIdle(1_000 + 14 * 60_000);
    expect(stopped).toEqual([]);
    await mgr.reapIdle(1_001 + 15 * 60_000 + 1);
    expect(stopped).toEqual([
      { id: 'a', reason: 'idle' },
      { id: 'b', reason: 'idle' },
    ]);
  });
});

describe("a deleted project's awake sites", () => {
  it('are stopped on the next pass, all of them, without waiting to go idle, and nothing fails', async () => {
    const { mgr, stopped, warnings, wake, db } = setup({ free: freeWith(100_000) });
    await wake('a', 'b', 'c');
    db.deleted.add('a');
    db.deleted.add('b');
    await mgr.reapIdle(2_000); // nowhere near idle
    expect(stopped).toEqual([
      { id: 'a', reason: 'deployment deleted or no longer served' },
      { id: 'b', reason: 'deployment deleted or no longer served' },
    ]);
    expect(warnings).toEqual([]); // recording the stop of a deleted deployment isn't an error
    expect(mgr.awake).toBe(1);
  });
});

describe("the sites' CPU group", () => {
  it('a site that Docker will not start in its CPU group starts without it, and says so', async () => {
    await writeFile(join(bin, 'refuse-cgroup'), '');
    try {
      const { mgr, warnings } = setup({ free: null, cgroupParent: 'autodeploy-sites.slice' });
      await mgr.ensure('a');
      expect(mgr.awake).toBe(1);
      expect(warnings).toEqual(['could not start the site in its CPU group; starting it without']);
    } finally {
      await rm(join(bin, 'refuse-cgroup'));
    }
    const { mgr, warnings } = setup({ free: null, cgroupParent: 'autodeploy-sites.slice' });
    await mgr.ensure('b');
    expect(warnings).toEqual([]); // accepted: no retry
  });
});

describe("a fork's preview", () => {
  it("runs without the project's variables; every other site gets them", async () => {
    const { mgr, db } = setup({ free: null });
    db.forks.add('from-a-fork');
    await mgr.ensure('from-a-fork');
    expect(db.secretReads).toEqual([]);
    await mgr.ensure('own-branch');
    expect(db.secretReads).toEqual(['project']);
  });
});

describe('server bundles on the VM', () => {
  it('a build leaves its bundle unpacked where the gateway looks, once, leaving nothing half-done', async () => {
    const src = await mkdtemp(join(tmpdir(), 'bundle-src-'));
    await writeFile(join(src, 'server.js'), 'console.log(1)');
    const file = join(await mkdtemp(join(tmpdir(), 'tgz-')), 'bundle.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', src, '.']);
    const root = join(await mkdtemp(join(tmpdir(), 'runtimes-')), 'runtimes');
    expect(await primeBundle(root, 'abc', file)).toBe(true);
    expect(await readFile(join(root, 'abc', 'server.js'), 'utf8')).toBe('console.log(1)');
    expect(await primeBundle(root, 'abc', file)).toBe(false);
    expect(await readdir(root)).toEqual(['abc']);
  });

  it('keeps those running, live or used in the last 24 hours, and deletes the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prune-'));
    const old = new Date(Date.now() - 48 * 3_600_000);
    for (const name of ['sha1', 'live-sha', 'old-sha', 'recent-sha', 'old-sha.tmp-abc123']) {
      await mkdir(join(dir, name));
      if (name !== 'recent-sha') await utimes(join(dir, name), old, old);
    }
    const { mgr, wake } = setup({ free: null, bundlesDir: dir, liveShas: ['live-sha'] });
    await wake('a'); // runs from sha1
    await utimes(join(dir, 'sha1'), old, old); // running, though last unpacked long ago
    expect(await mgr.pruneBundles()).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['live-sha', 'recent-sha', 'sha1']);
  });
});

describe('reading memory', () => {
  it("reads the VM's available memory, and gives null where there is none", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meminfo-'));
    const file = join(dir, 'meminfo');
    await writeFile(
      file,
      'MemTotal:       12010844 kB\nMemFree:          812344 kB\nMemAvailable:    7340032 kB\n',
    );
    expect(await availableMemoryMb(file)).toBe(7168);
    expect(await availableMemoryMb(join(dir, 'missing'))).toBeNull();
  });
  it('understands Docker memory sizes', () => {
    expect(mib('256m')).toBe(256);
    expect(mib('3g')).toBe(3072);
    expect(mib('512k')).toBe(0.5);
    expect(() => mib('lots')).toThrow();
  });
});

describe('a server that dies', () => {
  const lastError = (db: { records: Record<string, unknown>[] }) =>
    db.records.filter((r) => r.error !== undefined).at(-1)?.error;

  it('killed for going over its memory: forgotten, the reason recorded, and the next visit starts it again', async () => {
    const { mgr, wake, db, warnings } = setup({ free: null });
    const [a] = await wake('a');
    await writeFile(join(bin, `dead-${a!.container}`), '');
    expect(await mgr.dropIfDead(a!)).toBe(true);
    expect(mgr.awake).toBe(0);
    expect(lastError(db)).toMatch(/ran out of memory \(its limit is 256m\)/);
    expect(warnings).toContain('runtime died');
    const again = await mgr.ensure('a');
    expect(again).not.toBe(a);
    expect(mgr.awake).toBe(1);
  });

  it('with its container gone entirely, the same', async () => {
    const { mgr, wake, db } = setup({ free: null });
    const [a] = await wake('a');
    await writeFile(join(bin, `gone-${a!.container}`), '');
    expect(await mgr.dropIfDead(a!)).toBe(true);
    expect(lastError(db)).toMatch(/its container is gone/);
    expect(mgr.awake).toBe(0);
  });

  it('a server still running is left alone', async () => {
    const { mgr, wake } = setup({ free: null });
    const [a] = await wake('a');
    expect(await mgr.dropIfDead(a!)).toBe(false);
    expect(mgr.awake).toBe(1);
  });

  it('one that died with nobody visiting is forgotten on the next regular pass', async () => {
    const { mgr, wake } = setup({ free: null });
    const [a, b] = await wake('a', 'b');
    await writeFile(join(bin, `dead-${a!.container}`), '');
    await mgr.reapIdle(2_000);
    expect(mgr.awake).toBe(1);
    expect(await mgr.ensure('b')).toBe(b);
  });
});

describe('the proxy, when the server it was sent to is dead', () => {
  /** A gateway in front of a closed port, answering what `onError` returns. */
  async function front(onError: () => 'retry' | undefined, method: string) {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const gw = createServer((req, res) =>
      proxyToApp(
        req,
        res,
        { host: '127.0.0.1', port: deadPort },
        { memory: new Map(), learn() {} },
        () => {
          const answer = onError();
          if (answer === 'retry') res.end('sent again'); // what the gateway does: a fresh start
          return answer;
        },
      ),
    );
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(gw.address() as AddressInfo).port}/`, {
      method,
      ...(method === 'POST' && { body: 'x' }),
    });
    const out = { status: res.status, body: await res.text() };
    gw.close();
    return out;
  }

  it('leaves a page load to the gateway to send again', async () => {
    expect(await front(() => 'retry', 'GET')).toEqual({ status: 200, body: 'sent again' });
  });

  it('answers 502 when the gateway does not send it again', async () => {
    const r = await front(() => undefined, 'POST');
    expect(r.status).toBe(502);
    expect(r.body).toContain('This site stopped responding.');
  });
});

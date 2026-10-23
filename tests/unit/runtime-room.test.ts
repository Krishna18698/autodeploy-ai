import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
import {
  availableMemoryMb,
  type Instance,
  mib,
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
case "$1" in
  run) echo container-id ;;
  port) echo "0.0.0.0:${port}" ;;
  inspect) echo true ;;
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

// Every query answers for a live server-rendered deployment; nothing else is read.
const sql = ((first: unknown) => {
  if (!Array.isArray(first)) return first; // the sql(row) helper
  const live = {
    org_id: 'org',
    project_id: 'project',
    status: 'ACTIVE',
    mode: 'ssr',
    runtime_sha: 'sha1',
    runtime_node: 22,
    runtime_command: null,
    runtime_workdir: null,
  };
  return Promise.resolve((first as string[]).join('?').includes('from deployments') ? [live] : []);
}) as unknown as Sql;

function setup(o: { maxAwake?: number; free: ((awake: number) => number) | null }) {
  const stopped: { id: string; reason: string }[] = [];
  const log = {
    info: (f: { deploymentId?: string; reason?: string }) => {
      if (f.reason && f.deploymentId) stopped.push({ id: f.deploymentId, reason: f.reason });
    },
    warn() {},
    debug() {},
    error() {},
  } as unknown as Logger;
  const env = {
    SANDBOX_RUNTIME: 'runc',
    SANDBOX_IMAGE_PREFIX: 'node:',
    RUNTIME_REACH: 'publish',
    RUNTIME_NETWORK: 'n',
    RUNTIME_PROXY: 'http://proxy:3129',
    RUNTIME_BUNDLES_DIR: bundles,
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
  return { mgr, stopped, wake };
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

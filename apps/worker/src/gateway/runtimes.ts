import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Keyring } from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';
import type { Storage } from '@autodeploy/storage';
import type { Logger } from '@autodeploy/telemetry';
import type { Env } from '../env.js';
import { proxyByAddress } from '../executors/proxy-address.js';
import { runProcess } from '../executors/sandbox.js';
import { runtimeKey } from '../pipeline/runtime-bundle.js';
import { loadSecrets } from '../pipeline/secrets.js';

// Starts SSR deployments as containers on demand and stops them when idle
// (ADR 0008). One instance per deployment; containers are named ad-run-*.

export type RuntimeDeps = {
  env: Env;
  sql: Sql;
  storage: Storage;
  keyring: Keyring;
  log: Logger;
  /** The VM's available memory in MiB; null where it can't be read. Tests replace it. */
  freeMemoryMb?: () => Promise<number | null>;
};

/**
 * MemAvailable from /proc/meminfo. A container sees the VM's own figure (the
 * gateway runs under runc, not gVisor); off Linux there is none, and null
 * leaves only the awake limit.
 */
export async function availableMemoryMb(path = '/proc/meminfo'): Promise<number | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  const kb = text && /^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1];
  return kb ? Math.floor(Number(kb) / 1024) : null;
}

/** A Docker memory size ('256m', '1g', '512k') in MiB. */
export function mib(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(size.trim());
  if (!m) throw new Error(`not a memory size: ${size}`);
  const unit = (m[2] ?? 'b').toLowerCase();
  return (
    Number(m[1]) * { b: 1 / 1048576, k: 1 / 1024, m: 1, g: 1024 }[unit as 'b' | 'k' | 'm' | 'g']
  );
}

export type Instance = {
  deploymentId: string;
  orgId: string;
  /** Its bundle's sha (the directory under RUNTIME_BUNDLES_DIR). */
  sha: string;
  container: string;
  host: string;
  port: number;
  startedAt: number;
  lastRequest: number;
  active: number;
  requests: number;
};

export class RuntimeUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SERVE_STATUSES = ['READY', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'AWAITING_APPROVAL'];

type DeploymentRow = {
  org_id: string;
  /** A pull request from a fork: it runs without the project's variables. */
  from_fork: boolean;
  project_id: string;
  status: string;
  mode: string;
  runtime_sha: string | null;
  runtime_node: number | null;
  runtime_command: string | null;
  runtime_workdir: string | null;
};

export class RuntimeManager {
  private readonly running = new Map<string, Instance>();
  private readonly starting = new Map<string, Promise<Instance>>();
  /** Starts let in (a slot and memory counted for them) that aren't running yet. */
  private admitted = 0;
  private admitting: Promise<unknown> = Promise.resolve();
  private readonly capMb: number;

  constructor(private readonly d: RuntimeDeps) {
    this.capMb = mib(d.env.RUNTIME_MEMORY);
  }

  get awake(): number {
    return this.running.size;
  }

  /** The running instance for a deployment, starting it if needed (deduplicated). */
  async ensure(deploymentId: string): Promise<Instance> {
    const hit = this.running.get(deploymentId);
    if (hit) return hit;
    const pending = this.starting.get(deploymentId);
    if (pending) return pending;
    const p = this.start(deploymentId).finally(() => {
      this.starting.delete(deploymentId);
    });
    this.starting.set(deploymentId, p);
    return p;
  }

  private async start(deploymentId: string): Promise<Instance> {
    const t0 = performance.now();
    const [dep] = await this.d.sql<
      DeploymentRow[]
    >`select org_id, from_fork, project_id, status, mode, runtime_sha, runtime_node, runtime_command, runtime_workdir
      from deployments where id = ${deploymentId}`;
    if (dep?.mode !== 'ssr' || !dep.runtime_sha || !SERVE_STATUSES.includes(dep.status))
      throw new RuntimeUnavailable(404, 'No server-rendered deployment is live here.');

    await this.admit();
    try {
      return await this.launch(deploymentId, { ...dep, runtime_sha: dep.runtime_sha }, t0);
    } finally {
      this.admitted--;
    }
  }

  private async launch(
    deploymentId: string,
    dep: DeploymentRow & { runtime_sha: string },
    t0: number,
  ): Promise<Instance> {
    await this.record(deploymentId, dep.org_id, { status: 'starting', error: null });
    const { dir: bundle, cached } = await this.bundle(dep.runtime_sha);
    const tBundle = performance.now();
    const secrets = dep.from_fork ? {} : await loadSecrets(this.d, dep.project_id);
    const container = `ad-run-${deploymentId.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
    const e = this.d.env;
    const proxy =
      e.SANDBOX_RUNTIME === 'runsc'
        ? await proxyByAddress(e.RUNTIME_PROXY, e.RUNTIME_NETWORK)
        : e.RUNTIME_PROXY;
    const env: Record<string, string> = {
      ...secrets,
      NODE_ENV: 'production',
      // Frameworks read different names: PORT/HOST (most), HOSTNAME (Next).
      PORT: '3000',
      HOST: '0.0.0.0',
      HOSTNAME: '0.0.0.0',
      NEXT_TELEMETRY_DISABLED: '1',
      // Outbound HTTP(S) only through the SSRF-guarded public proxy.
      ...(e.RUNTIME_REACH === 'network' && {
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        NO_PROXY: 'localhost,127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
        NODE_OPTIONS: '--disable-warning=UNDICI-EHPA',
      }),
    };
    const args = (env_: typeof e) =>
      containerArgs({
        container,
        deploymentId,
        bundle,
        image: `${e.SANDBOX_IMAGE_PREFIX}${dep.runtime_node ?? 22}`,
        // Older Next.js deployments recorded no command: they run server.js.
        command: dep.runtime_command ?? 'node server.js',
        workdir: dep.runtime_workdir ?? '.',
        env,
        env_,
      });
    const out: string[] = [];
    let code = await runProcess('docker', args(e), (l) => out.push(l));
    if (code === 125 && e.RUNTIME_CGROUP_PARENT) {
      // Docker itself refused (125), with the sites' CPU group in play: a site
      // that runs without the CPU split beats a site that doesn't run.
      this.d.log.warn(
        { deploymentId, cgroupParent: e.RUNTIME_CGROUP_PARENT, error: out.join(' ').slice(0, 500) },
        'could not start the site in its CPU group; starting it without',
      );
      await runProcess('docker', ['rm', '-f', container], () => {});
      out.length = 0;
      code = await runProcess('docker', args({ ...e, RUNTIME_CGROUP_PARENT: '' }), (l) =>
        out.push(l),
      );
    }
    if (code !== 0) {
      await this.record(deploymentId, dep.org_id, { status: 'failed', error: out.join(' ') });
      throw new RuntimeUnavailable(502, 'This site could not be started.');
    }
    const tRun = performance.now();
    const target = await this.address(container);
    const ready = await this.waitReady(target, container);
    if (!ready.ok) {
      const logs: string[] = [];
      await runProcess('docker', ['logs', '--tail', '15', container], (l) => logs.push(l));
      await runProcess('docker', ['rm', '-f', container], () => {});
      const error =
        (ready.exited ? 'server exited: ' : 'server did not answer: ') + logs.join(' | ');
      await this.record(deploymentId, dep.org_id, {
        status: 'failed',
        error: error.slice(0, 1000),
      });
      throw new RuntimeUnavailable(502, 'This site failed to start.');
    }
    const tReady = performance.now();
    const now = Date.now();
    const inst: Instance = {
      deploymentId,
      orgId: dep.org_id,
      sha: dep.runtime_sha,
      container,
      ...target,
      startedAt: now,
      lastRequest: now,
      active: 0,
      requests: 0,
    };
    this.running.set(deploymentId, inst);
    const coldStartMs = Math.round(performance.now() - t0);
    await this.record(deploymentId, dep.org_id, {
      status: 'running',
      container,
      started_at: new Date(now),
      cold_start_ms: coldStartMs,
      error: null,
    });
    // Where the time went: fetching and unpacking the bundle (none when the
    // build left it on disk), starting the container, the server getting ready.
    this.d.log.info(
      {
        deploymentId,
        container,
        coldStartMs,
        bundleCached: cached,
        bundleMs: Math.round(tBundle - t0),
        runMs: Math.round(tRun - tBundle),
        readyMs: Math.round(tReady - tRun),
      },
      'runtime started',
    );
    return inst;
  }

  /**
   * The bundle unpacked on disk, shared by every start of the same build. The
   * build usually left it there (primeBundle); otherwise it's fetched now.
   * Each use marks it as used, so pruneBundles keeps it.
   */
  private async bundle(sha: string): Promise<{ dir: string; cached: boolean }> {
    const root = this.d.env.RUNTIME_BUNDLES_DIR;
    const dir = join(root, sha);
    if (await stat(dir).catch(() => null)) {
      const now = new Date();
      await utimes(dir, now, now).catch(() => {});
      return { dir, cached: true };
    }
    const obj = await this.d.storage.getStream(runtimeKey(sha));
    if (!obj) throw new RuntimeUnavailable(502, 'This build is no longer stored.');
    await unpackBundle(root, sha, obj.body);
    return { dir, cached: false };
  }

  private async address(container: string): Promise<{ host: string; port: number }> {
    if (this.d.env.RUNTIME_REACH === 'network') return { host: container, port: 3000 };
    const out: string[] = [];
    await runProcess('docker', ['port', container, '3000/tcp'], (l) => out.push(l));
    const m = /:(\d+)\s*$/.exec(out[0] ?? '');
    if (!m?.[1]) throw new RuntimeUnavailable(502, 'This site could not be reached.');
    return { host: '127.0.0.1', port: Number(m[1]) };
  }

  private async waitReady(
    t: { host: string; port: number },
    container: string,
  ): Promise<{ ok: boolean; exited?: boolean }> {
    // Asks every 100 ms; whether the server has exited (a docker call, slower)
    // only every 10th time.
    const deadline = Date.now() + this.d.env.RUNTIME_START_TIMEOUT_S * 1000;
    for (let i = 1; Date.now() < deadline; i++) {
      const ok = await fetch(`http://${t.host}:${t.port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      }).then(
        () => true,
        () => false,
      );
      if (ok) return { ok: true };
      if (i % 10 === 0) {
        const state: string[] = [];
        await runProcess('docker', ['inspect', '-f', '{{.State.Running}}', container], (l) =>
          state.push(l),
        );
        if (state[0]?.trim() === 'false') return { ok: false, exited: true };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false };
  }

  touch(inst: Instance) {
    inst.lastRequest = Date.now();
    inst.requests++;
  }

  /**
   * Lets a start in when there's a slot (RUNTIME_MAX_AWAKE) and memory for it:
   * the VM's available memory, less what starts already let in may still take,
   * must leave RUNTIME_MIN_FREE_MB spare. Otherwise the longest-idle instances
   * are stopped first; with none idle, the visitor is asked to retry. One
   * decision at a time, so a burst of wakes can't all count the same memory.
   */
  private admit(): Promise<void> {
    const next = this.admitting.then(() => this.makeRoom());
    this.admitting = next.catch(() => {});
    return next;
  }

  private async makeRoom() {
    const e = this.d.env;
    const need = this.capMb + e.RUNTIME_MIN_FREE_MB;
    for (;;) {
      const full = this.running.size + this.admitted >= e.RUNTIME_MAX_AWAKE;
      const free = await this.freeMb();
      const low = free !== null && free - this.admitted * this.capMb < need;
      if (!full && !low) break;
      const idle = this.longestIdle();
      if (!idle) {
        this.d.log.warn({ awake: this.running.size, freeMb: free }, 'no room to start a server');
        throw new RuntimeUnavailable(503, 'All site slots are busy; try again shortly.');
      }
      await this.stop(
        idle.deploymentId,
        full ? 'evicted (awake limit)' : `evicted (low memory: ${free} MiB free)`,
      );
    }
    this.admitted++;
  }

  private freeMb(): Promise<number | null> {
    return (this.d.freeMemoryMb ?? availableMemoryMb)();
  }

  /** The awake instance unused the longest with no request in flight. */
  private longestIdle(): Instance | undefined {
    return [...this.running.values()]
      .filter((i) => i.active === 0)
      .sort((a, b) => a.lastRequest - b.lastRequest)[0];
  }

  async stop(deploymentId: string, reason: string) {
    const inst = this.running.get(deploymentId);
    if (!inst) return;
    this.running.delete(deploymentId);
    await runProcess('docker', ['rm', '-f', inst.container], () => {});
    await this.record(deploymentId, inst.orgId, { status: 'stopped', requests: inst.requests });
    this.d.log.info({ deploymentId, reason, requests: inst.requests }, 'runtime stopped');
  }

  /**
   * Stops instances with no requests for RUNTIME_IDLE_MIN and none in flight.
   * Then, if memory runs low anyway (a build started, or awake servers grew
   * into their caps), the longest-idle ones until half of RUNTIME_MIN_FREE_MB
   * is free again: a site that sleeps wakes on its next visit, a VM out of
   * memory takes everything down.
   */
  async reapIdle(now = Date.now()) {
    await this.reconcile();
    const limit = this.d.env.RUNTIME_IDLE_MIN * 60_000;
    for (const i of [...this.running.values()]) {
      if (i.active === 0 && now - i.lastRequest > limit)
        await this.stopSafely(i.deploymentId, 'idle');
    }
    for (;;) {
      const free = await this.freeMb();
      if (free === null || free >= this.d.env.RUNTIME_MIN_FREE_MB / 2) return;
      const idle = this.longestIdle();
      if (!idle) return;
      await this.stopSafely(idle.deploymentId, `low memory (${free} MiB free)`);
    }
  }

  /**
   * Stops, at once, instances whose deployment is gone (its project deleted)
   * or can no longer be served, instead of leaving them to the idle timeout.
   */
  async reconcile() {
    const ids = [...this.running.keys()];
    if (ids.length === 0) return;
    const rows = await this.d.sql<{ id: string; status: string }[]>`
      select id, status from deployments where id = any(${ids})`;
    const servable = new Set(
      rows.filter((r) => SERVE_STATUSES.includes(r.status)).map((r) => r.id),
    );
    for (const id of ids) {
      if (!servable.has(id)) await this.stopSafely(id, 'deployment deleted or no longer served');
    }
  }

  /** stop(), where one failure mustn't keep the next instance running. */
  private async stopSafely(deploymentId: string, reason: string) {
    await this.stop(deploymentId, reason).catch((err) =>
      this.d.log.warn({ err, deploymentId, reason }, 'runtime stop failed'),
    );
  }

  /**
   * Unpacked bundles stay on disk for running instances, every project's live
   * deployment, and anything built or started in the last RUNTIME_BUNDLE_KEEP_H
   * hours; the rest are deleted (they're still in object storage, so a later
   * start fetches them again). Returns how many were deleted.
   */
  async pruneBundles(now = Date.now()): Promise<number> {
    const root = this.d.env.RUNTIME_BUNDLES_DIR;
    const names = await readdir(root).catch(() => [] as string[]);
    if (names.length === 0) return 0;
    const live = await this.d.sql<{ sha: string }[]>`
      select distinct d.runtime_sha as sha from projects p
      join deployments d on d.id = p.active_deployment_id
      where d.runtime_sha = any(${names})`;
    const keep = new Set([
      ...live.map((r) => r.sha),
      ...[...this.running.values()].map((i) => i.sha),
    ]);
    const maxAge = this.d.env.RUNTIME_BUNDLE_KEEP_H * 3_600_000;
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      const st = await stat(join(root, name)).catch(() => null);
      if (!st || now - st.mtimeMs < maxAge) continue;
      await rm(join(root, name), { recursive: true, force: true });
      removed++;
    }
    if (removed > 0)
      this.d.log.info({ removed, kept: names.length - removed }, 'old bundles removed');
    return removed;
  }

  /** Persists last-request times so the dashboard can show activity. */
  async flush() {
    for (const i of this.running.values()) {
      await this.d.sql`update runtime_instances set last_request_at = ${new Date(i.lastRequest)},
        requests = ${i.requests}, updated_at = now() where deployment_id = ${i.deploymentId}`;
    }
  }

  /** On boot: nothing from a previous gateway process is trusted. */
  async cleanupOrphans() {
    const ids: string[] = [];
    await runProcess('docker', ['ps', '-aq', '--filter', 'name=ad-run-'], (l) =>
      ids.push(l.trim()),
    );
    if (ids.length > 0) await runProcess('docker', ['rm', '-f', ...ids], () => {});
    await this.d.sql`update runtime_instances set status = 'stopped', updated_at = now()
      where status in ('starting', 'running')`;
  }

  async stopAll() {
    for (const id of [...this.running.keys()]) await this.stop(id, 'gateway shutdown');
  }

  private async record(
    deploymentId: string,
    orgId: string,
    f: Partial<{
      status: string;
      container: string;
      started_at: Date;
      cold_start_ms: number;
      requests: number;
      error: string | null;
    }>,
  ) {
    const row = { deployment_id: deploymentId, org_id: orgId, ...f, updated_at: new Date() };
    await this.d.sql`insert into runtime_instances ${this.d.sql(row)}
      on conflict (deployment_id) do update set ${this.d.sql(
        Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'deployment_id')),
      )}`.catch((err: { code?: string }) => {
      // The deployment was deleted meanwhile (with its project): nothing to record.
      if (err.code !== '23503') throw err;
    });
  }
}

/**
 * Unpacks a bundle (.tar.gz) into <root>/<sha>. The directory only appears,
 * renamed into place, once complete; if another unpack got there first, that
 * one stands.
 */
export async function unpackBundle(root: string, sha: string, source: Readable): Promise<void> {
  const dir = join(root, sha);
  const tmp = `${dir}.tmp-${randomBytes(3).toString('hex')}`;
  await mkdir(tmp, { recursive: true });
  try {
    await feedProcess([source, createGunzip()], 'tar', ['-x', '-C', tmp]);
    await rename(tmp, dir).catch(async (err) => {
      if (
        (err as NodeJS.ErrnoException).code === 'ENOTEMPTY' ||
        (await stat(dir).catch(() => null))
      )
        return;
      throw err;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Called by the build: leaves the new bundle unpacked where the gateway looks,
 * so the first visit after a deploy doesn't fetch and unpack it (~4 s of a
 * Next.js wake, capacity test 2026-10-24). Returns false if it was there already.
 */
export async function primeBundle(root: string, sha: string, file: string): Promise<boolean> {
  if (await stat(join(root, sha)).catch(() => null)) return false;
  await mkdir(root, { recursive: true });
  await unpackBundle(root, sha, createReadStream(file));
  return true;
}

/**
 * `docker run` for one server: read-only bundle, non-root, capped, tmpfs for
 * /tmp. The start command runs in the bundle's workdir with its node_modules
 * binaries on PATH, as npm would run a script. Next.js bundles also get a
 * tmpfs for .next/cache (its build leaves the mount point in the bundle).
 */
export function containerArgs(o: {
  container: string;
  deploymentId: string;
  bundle: string;
  image: string;
  command: string;
  workdir: string;
  env: Record<string, string>;
  env_: Pick<
    Env,
    | 'SANDBOX_RUNTIME'
    | 'RUNTIME_REACH'
    | 'RUNTIME_NETWORK'
    | 'RUNTIME_MEMORY'
    | 'RUNTIME_CPUS'
    | 'RUNTIME_CPU_SHARES'
    | 'RUNTIME_CGROUP_PARENT'
  >;
}): string[] {
  const e = o.env_;
  const wd = posix.join('/app', posix.normalize(o.workdir).replace(/^(\.\.(\/|$))+/, ''));
  const next = o.command === 'node server.js' && wd === '/app';
  const env = {
    ...o.env,
    HOME: '/tmp',
    PATH: `${wd}/node_modules/.bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
  };
  return [
    'run',
    '-d',
    '--name',
    o.container,
    '--label',
    `autodeploy.deployment=${o.deploymentId}`,
    ...(e.SANDBOX_RUNTIME === 'runsc' ? ['--runtime=runsc'] : []),
    ...(e.RUNTIME_REACH === 'network'
      ? ['--network', e.RUNTIME_NETWORK]
      : ['-p', '127.0.0.1::3000']),
    '--memory',
    e.RUNTIME_MEMORY,
    '--memory-swap',
    e.RUNTIME_MEMORY,
    '--cpus',
    e.RUNTIME_CPUS,
    '--cpu-shares',
    String(e.RUNTIME_CPU_SHARES),
    ...(e.RUNTIME_CGROUP_PARENT ? ['--cgroup-parent', e.RUNTIME_CGROUP_PARENT] : []),
    '--pids-limit',
    '128',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=64m',
    ...(next ? ['--tmpfs', '/app/.next/cache:rw,nosuid,size=64m,mode=1777'] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '-v',
    `${o.bundle}:/app:ro`,
    '-w',
    wd,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    o.image,
    'sh',
    '-c',
    // exec: the server itself gets the stop signal (a shell wouldn't pass it
    // on); a compound command (a && b) has to stay a shell.
    /[;&|]/.test(o.command) ? o.command : `exec ${o.command}`,
  ];
}

/**
 * Streams data through `transforms` into a command's stdin. The command's exit
 * code decides: tar stops reading at the archive's end marker, possibly while
 * gzip still holds the archive's zero padding, so its stdin closing early is
 * not a failure when it exits 0 (that race once broke random server starts).
 */
export async function feedProcess(
  [source, ...transforms]: [Readable, ...Transform[]],
  cmd: string,
  args: string[],
): Promise<void> {
  const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const fed = pipeline([source, ...transforms, child.stdin]).then(
    () => null,
    (err: NodeJS.ErrnoException) => err,
  );
  const [code, err] = await Promise.all([exited, fed]);
  if (code !== 0) throw new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
  if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'EPIPE') throw err;
}

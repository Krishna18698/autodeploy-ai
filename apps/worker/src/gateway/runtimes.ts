import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
};

export type Instance = {
  deploymentId: string;
  orgId: string;
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

export class RuntimeManager {
  private readonly running = new Map<string, Instance>();
  private readonly starting = new Map<string, Promise<Instance>>();

  constructor(private readonly d: RuntimeDeps) {}

  get awake(): number {
    return this.running.size;
  }

  /** The running instance for a deployment, starting it if needed (deduplicated). */
  async ensure(deploymentId: string): Promise<Instance> {
    const hit = this.running.get(deploymentId);
    if (hit) return hit;
    const pending = this.starting.get(deploymentId);
    if (pending) return pending;
    const p = this.start(deploymentId).finally(() => this.starting.delete(deploymentId));
    this.starting.set(deploymentId, p);
    return p;
  }

  private async start(deploymentId: string): Promise<Instance> {
    const t0 = performance.now();
    const [dep] = await this.d.sql<
      {
        org_id: string;
        project_id: string;
        status: string;
        mode: string;
        runtime_sha: string | null;
        runtime_node: number | null;
      }[]
    >`select org_id, project_id, status, mode, runtime_sha, runtime_node from deployments where id = ${deploymentId}`;
    if (dep?.mode !== 'ssr' || !dep.runtime_sha || !SERVE_STATUSES.includes(dep.status))
      throw new RuntimeUnavailable(404, 'No server-rendered deployment is live here.');

    await this.makeRoom();
    await this.record(deploymentId, dep.org_id, { status: 'starting', error: null });
    const bundle = await this.bundle(dep.runtime_sha);
    const secrets = await loadSecrets(this.d, dep.project_id);
    const container = `ad-run-${deploymentId.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
    const e = this.d.env;
    const proxy =
      e.SANDBOX_RUNTIME === 'runsc'
        ? await proxyByAddress(e.RUNTIME_PROXY, e.RUNTIME_NETWORK)
        : e.RUNTIME_PROXY;
    const env: Record<string, string> = {
      ...secrets,
      NODE_ENV: 'production',
      PORT: '3000',
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
    const args = [
      'run',
      '-d',
      '--name',
      container,
      '--label',
      `autodeploy.deployment=${deploymentId}`,
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
      '--pids-limit',
      '128',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,size=64m',
      '--tmpfs',
      '/app/.next/cache:rw,nosuid,size=64m,mode=1777',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '-v',
      `${bundle}:/app:ro`,
      '-w',
      '/app',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      `${e.SANDBOX_IMAGE_PREFIX}${dep.runtime_node ?? 22}`,
      'node',
      'server.js',
    ];
    const out: string[] = [];
    if ((await runProcess('docker', args, (l) => out.push(l))) !== 0) {
      await this.record(deploymentId, dep.org_id, { status: 'failed', error: out.join(' ') });
      throw new RuntimeUnavailable(502, 'This site could not be started.');
    }
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
    const now = Date.now();
    const inst: Instance = {
      deploymentId,
      orgId: dep.org_id,
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
    this.d.log.info({ deploymentId, container, coldStartMs }, 'runtime started');
    return inst;
  }

  /** The bundle unpacked on disk (shared by every start of the same build). */
  private async bundle(sha: string): Promise<string> {
    const dir = join(this.d.env.RUNTIME_BUNDLES_DIR, sha);
    if (await stat(join(dir, 'server.js')).catch(() => null)) return dir;
    const obj = await this.d.storage.getStream(runtimeKey(sha));
    if (!obj) throw new RuntimeUnavailable(502, 'This build is no longer stored.');
    const tmp = `${dir}.tmp-${randomBytes(3).toString('hex')}`;
    await mkdir(tmp, { recursive: true });
    try {
      const tar = spawn('tar', ['-x', '-C', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
      const done = new Promise<void>((resolve, reject) => {
        tar.on('error', reject);
        tar.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`tar exited ${c}`))));
      });
      await pipeline(obj.body, createGunzip(), tar.stdin);
      await done;
      await rename(tmp, dir).catch(async (err) => {
        // Another start unpacked it first.
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
    return dir;
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
    const deadline = Date.now() + this.d.env.RUNTIME_START_TIMEOUT_S * 1000;
    while (Date.now() < deadline) {
      const ok = await fetch(`http://${t.host}:${t.port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      }).then(
        () => true,
        () => false,
      );
      if (ok) return { ok: true };
      const state: string[] = [];
      await runProcess('docker', ['inspect', '-f', '{{.State.Running}}', container], (l) =>
        state.push(l),
      );
      if (state[0]?.trim() === 'false') return { ok: false, exited: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false };
  }

  touch(inst: Instance) {
    inst.lastRequest = Date.now();
    inst.requests++;
  }

  /** At the awake limit: stop the least recently used idle instance first. */
  private async makeRoom() {
    if (this.running.size < this.d.env.RUNTIME_MAX_AWAKE) return;
    const idle = [...this.running.values()]
      .filter((i) => i.active === 0)
      .sort((a, b) => a.lastRequest - b.lastRequest)[0];
    if (!idle) throw new RuntimeUnavailable(503, 'All site slots are busy; try again shortly.');
    await this.stop(idle.deploymentId, 'evicted (awake limit)');
  }

  async stop(deploymentId: string, reason: string) {
    const inst = this.running.get(deploymentId);
    if (!inst) return;
    this.running.delete(deploymentId);
    await runProcess('docker', ['rm', '-f', inst.container], () => {});
    await this.record(deploymentId, inst.orgId, { status: 'stopped', requests: inst.requests });
    this.d.log.info({ deploymentId, reason, requests: inst.requests }, 'runtime stopped');
  }

  /** Stops instances with no requests for RUNTIME_IDLE_MIN and none in flight. */
  async reapIdle(now = Date.now()) {
    const limit = this.d.env.RUNTIME_IDLE_MIN * 60_000;
    for (const i of [...this.running.values()]) {
      if (i.active === 0 && now - i.lastRequest > limit) await this.stop(i.deploymentId, 'idle');
    }
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
      )}`;
  }
}

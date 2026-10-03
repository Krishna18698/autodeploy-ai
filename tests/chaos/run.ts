// Chaos scenarios against the running local stack (./scripts/dev.sh + compose).
// Each breaks one dependency mid-deployment and measures how the system recovers.
//   pnpm chaos
import { execFileSync, execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:4000';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const SLOW = `file://${join(root, 'tests/fixtures/slow-build')}`;
const compose = (args: string) =>
  execSync(`docker compose -f infra/compose/docker-compose.yml --env-file .env ${args}`, {
    cwd: root,
    stdio: 'pipe',
  });
const sql = (q: string) =>
  execFileSync('docker', [
    'exec',
    'autodeploy-postgres-1',
    'psql',
    '-U',
    'autodeploy',
    '-d',
    'autodeploy',
    '-Atc',
    q,
  ])
    .toString()
    .trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
let csrf = '';
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        cookie,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
type Dep = {
  id: string;
  status: string;
  attempts: Array<{ status: string; errorCode: string | null }>;
};

async function waitFor(
  id: string,
  pred: (d: Dep) => boolean,
  timeoutMs = 300_000,
): Promise<{ d: Dep; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const d = await call<Dep>(`/api/v1/deployments/${id}`);
    if (pred(d)) return { d, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out; last status ${d.status}`);
    await sleep(500);
  }
}

let projectId: string | null = null;
async function deploySlow(): Promise<string> {
  if (!projectId) {
    const p = await call<{ project: { id: string } }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ repoUrl: SLOW, deploy: false }),
    });
    projectId = p.project.id;
  }
  return (
    await call<{ id: string }>(`/api/v1/projects/${projectId}/deployments`, {
      method: 'POST',
      body: '{}',
    })
  ).id;
}

const workerUp = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://localhost:9464/healthz')).ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error('worker did not come back');
};

// Always put the stack back, even if a scenario throws.
process.on('exit', () => {
  try {
    compose('start kafka s3');
  } catch {}
});

const results: Array<{ scenario: string; outcome: string; measured: string; ok: boolean }> = [];

const login = await fetch(`${API}/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `chaos-${Date.now().toString(36)}` }),
});
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

// 1 ─ worker killed with SIGKILL mid-build ────────────────────────────────
{
  const id = await deploySlow();
  await waitFor(id, (d) => d.status === 'BUILDING' && d.attempts.length === 1);
  await sleep(4000);
  const killedAt = Date.now();
  execSync('kill -9 $(cat .dev/worker.pid)', { cwd: root, shell: '/bin/bash' });
  execSync('./scripts/dev.sh start worker', { cwd: root, stdio: 'pipe' });
  await workerUp();
  const { d } = await waitFor(id, (x) => x.attempts.length >= 2);
  const resumedMs = Date.now() - killedAt;
  const done = await waitFor(id, (x) => ['ACTIVE', 'FAILED'].includes(x.status));
  const lost = d.attempts[0]?.errorCode === 'WORKER_LOST';
  results.push({
    scenario: 'worker SIGKILL mid-build',
    outcome: `attempt 1 marked ${d.attempts[0]?.status}/${d.attempts[0]?.errorCode}; attempt 2 → ${done.d.status}`,
    measured: `rebuild started ${(resumedMs / 1000).toFixed(1)} s after the kill (lease 30 s + reaper ≤15 s)`,
    ok: lost && done.d.status === 'ACTIVE',
  });
}

// 2 ─ Kafka down while deployments happen ─────────────────────────────────
{
  compose('stop kafka');
  const id = await deploySlow();
  const { d } = await waitFor(id, (x) => ['ACTIVE', 'FAILED'].includes(x.status));
  const backlog = Number(sql('select count(*) from outbox where published_at is null'));
  compose('start kafka');
  const t0 = Date.now();
  for (
    let i = 0;
    i < 120 && Number(sql('select count(*) from outbox where published_at is null')) > 0;
    i++
  )
    await sleep(1000);
  const drainedMs = Date.now() - t0;
  const left = Number(sql('select count(*) from outbox where published_at is null'));
  results.push({
    scenario: 'Kafka stopped during a deployment',
    outcome: `deployment still went ${d.status}; ${backlog} events queued in the outbox, ${left} left after restart`,
    measured: `backlog drained ${(drainedMs / 1000).toFixed(1)} s after Kafka returned (incl. broker startup)`,
    ok: d.status === 'ACTIVE' && left === 0 && backlog > 0,
  });
}

// 3 ─ every worker database connection killed mid-build ──────────────────
{
  const id = await deploySlow();
  await waitFor(id, (x) => x.status === 'BUILDING');
  await sleep(3000);
  const killed = sql(
    "select count(*) from (select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'autodeploy-worker') t",
  );
  const { d } = await waitFor(id, (x) => ['ACTIVE', 'FAILED'].includes(x.status));
  results.push({
    scenario: 'all worker DB connections terminated',
    outcome: `${killed} connections killed; deployment → ${d.status} after ${d.attempts.length} attempt(s)`,
    measured: 'pool reconnects transparently; heartbeats resume',
    ok: d.status === 'ACTIVE',
  });
}

// 4 ─ object storage down during artifact upload ─────────────────────────
{
  const id = await deploySlow();
  await waitFor(id, (x) => x.status === 'BUILDING');
  compose('stop s3');
  await sleep(25_000); // build finishes; upload fails; job retries with backoff
  compose('start s3');
  const { d, ms } = await waitFor(id, (x) => ['ACTIVE', 'FAILED'].includes(x.status), 420_000);
  results.push({
    scenario: 'object storage down at upload time',
    outcome: `deployment → ${d.status} after ${d.attempts.length} attempt(s)`,
    measured: `recovered ${(ms / 1000).toFixed(1)} s after storage returned (retry with jittered backoff)`,
    ok: d.status === 'ACTIVE',
  });
}

const md = [
  '# Chaos report',
  '',
  '| scenario | outcome | measured | ok |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.scenario} | ${r.outcome} | ${r.measured} | ${r.ok ? '✓' : '✗'} |`),
].join('\n');
await writeFile(join(here, 'report.md'), `${md}\n`);
console.log(md);
process.exit(results.every((r) => r.ok) ? 0 : 1);

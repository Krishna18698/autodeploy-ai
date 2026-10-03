// Orchestrates the load test: prepares an org, 50 tokens and a project, runs
// k6 in Docker, then waits for every deployment and checks invariants.
//   pnpm load
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:4000';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
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
const run = Date.now().toString(36);

const login = await fetch(`${API}/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `load-${run}` }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
const h = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
const me = (await (await fetch(`${API}/api/v1/me`, { headers: h })).json()) as {
  org: { id: string };
};
sql(`update orgs set daily_deploy_quota = 1000 where id = '${me.org.id}'`);

const project = (await (
  await fetch(`${API}/api/v1/projects`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      repoUrl: `file://${join(root, 'tests/corpus/repos/ok-static-html')}`,
      deploy: false,
    }),
  })
).json()) as { project: { id: string } };
// 50 more projects for the spread scenario (created directly: the API would
// reject the same repo twice in one org, which is correct).
const spreadProjects = sql(
  `insert into projects (org_id, slug, name, repo_full_name, repo_url) select '${me.org.id}', 'load-${run}-' || g, 'load ' || g, 'local/load-${run}-' || g, 'file://${join(root, 'tests/corpus/repos/ok-static-html')}' from generate_series(1, 50) g returning id`,
)
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^[0-9a-f-]{36}$/.test(l));
const tokens: string[] = [];
for (let i = 0; i < 50; i++) {
  const t = (await (
    await fetch(`${API}/api/v1/tokens`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: `load-${i}`, scopes: ['deploy'] }),
    })
  ).json()) as { token: string };
  tokens.push(t.token);
}
await writeFile(
  join(here, 'config.json'),
  JSON.stringify({
    api: 'http://host.docker.internal:4000',
    projectId: project.project.id,
    spreadProjects,
    tokens,
    run,
  }),
);

console.log('running k6 (50 concurrent deploys + 20 polling dashboards for 30 s)…');
let k6: string;
try {
  k6 = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${here}:/load`,
      'grafana/k6:latest',
      'run',
      '--summary-trend-stats',
      'p(50),p(95),p(99),max',
      '/load/deploy.js',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (err) {
  k6 = String((err as { stdout?: string }).stdout ?? err);
}
const pick = (re: RegExp) => re.exec(k6)?.[0] ?? '';
console.log(pick(/http_req_duration[^\n]*\n(?:\s+\{[^\n]*\n)+/));
console.log(pick(/checks[^\n]*\n/), pick(/http_reqs[^\n]*\n/));

// Wait for the builds, then check invariants.
const pid = project.project.id;
const allIds = [pid, ...spreadProjects].map((x) => `'${x}'`).join(',');
for (let i = 0; i < 600; i++) {
  const pending = Number(
    sql(
      `select count(*) from deployments where project_id in (${allIds}) and status not in ('READY','ACTIVE','FAILED','CANCELED','SUPERSEDED')`,
    ),
  );
  if (pending === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const created = Number(sql(`select count(*) from deployments where project_id in (${allIds})`));
const ready = Number(
  sql(`select count(*) from deployments where project_id in (${allIds}) and status = 'READY'`),
);
const multiAttempt = Number(
  sql(
    `select count(*) from (select deployment_id from deployment_attempts a join deployments d on d.id = a.deployment_id where d.project_id in (${allIds}) group by 1 having count(*) > 1) t`,
  ),
);
const dupJobs = Number(
  sql(
    `select count(*) from (select payload->>'deploymentId' from jobs where type = 'deployment.build' and payload->>'deploymentId' in (select id::text from deployments where project_id in (${allIds})) group by 1 having count(*) > 1) t`,
  ),
);
const wait = sql(
  `select round(percentile_cont(0.5) within group (order by extract(epoch from (started_at - queued_at)))::numeric, 1) || ' s / ' || round(percentile_cont(0.95) within group (order by extract(epoch from (started_at - queued_at)))::numeric, 1) || ' s' from deployments where project_id in (${allIds})`,
);
const span = sql(
  `select round(extract(epoch from max(finished_at) - min(created_at))::numeric, 1) from deployments where project_id in (${allIds})`,
);
const report = [
  '# Load report',
  '',
  '```',
  pick(/http_req_duration[^\n]*\n(?:\s+\{[^\n]*\n)+/).trim(),
  pick(/checks[^\n]*/).trim(),
  pick(/http_reqs[^\n]*/).trim(),
  '```',
  '',
  `- deployments created: ${created}/100 · built and ready: ${ready}`,
  `- deployments with more than one build attempt: ${multiAttempt} · duplicate build jobs: ${dupJobs}`,
  `- queue wait p50 / p95: ${wait} (2 build slots on this machine)`,
  `- all 100 drained in ${span} s`,
].join('\n');
await writeFile(join(here, 'report.md'), `${report}\n`);
console.log(report);
process.exit(created === 100 && ready === 100 && multiAttempt === 0 && dupJobs === 0 ? 0 : 1);

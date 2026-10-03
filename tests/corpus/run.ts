// Deploys every corpus repository through the real API + worker and compares
// the outcome with its label.
//   rules only:  AI_PROVIDERS= ./scripts/dev.sh restart worker && pnpm corpus --mode rules
//   rules + AI:  AI_PROVIDERS=mock ./scripts/dev.sh restart worker && pnpm corpus --mode ai
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expect } from './generate';

const API = process.env.API_URL ?? 'http://localhost:4000';
const mode = (
  process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'ai'
) as 'ai' | 'rules';
const here = dirname(fileURLToPath(import.meta.url));
const SECRET = 'corpus-s3cret-value-9f2c41';
const TERMINAL = new Set([
  'ACTIVE',
  'READY',
  'FAILED',
  'NEEDS_INPUT',
  'AWAITING_APPROVAL',
  'CANCELED',
]);

let cookie = '';
let csrf = '';
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  for (;;) {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        cookie,
        'x-csrf-token': csrf,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    // A good client honours the API's rate limits instead of failing.
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000));
  }
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

type Dep = {
  id: string;
  status: string;
  recoveredBy: string | null;
  attempts: Array<{ durationMs: number | null }>;
  createdAt: string;
  finishedAt: string | null;
};
type Result = {
  name: string;
  expected: Expect;
  rule: string | null;
  actual: string;
  ruleUsed: string | null;
  attempts: number;
  seconds: number;
  ok: boolean;
  check?: string;
  note: string;
};

async function waitTerminal(id: string, timeoutMs = 8 * 60_000): Promise<Dep> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await call<Dep>(`/api/v1/deployments/${id}`);
    if (TERMINAL.has(d.status) && !(d.status === 'READY')) return d;
    if (Date.now() > end) return d;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function logs(id: string): Promise<string> {
  const r = await call<{ lines: Array<{ text: string }> }>(`/api/v1/deployments/${id}/logs`);
  return r.lines.map((l) => l.text).join('\n');
}

const login = await fetch(`${API}/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: `corpus-${mode}-${Date.now().toString(36)}` }),
});
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
csrf = ((await login.json()) as { csrfToken: string }).csrfToken;

const names = (await readdir(join(here, 'repos'))).sort();
const started = Date.now();
const jobs = names.map(async (name): Promise<Result> => {
  const dir = join(here, 'repos', name);
  const label = JSON.parse(await readFile(join(dir, '.corpus.json'), 'utf8')) as {
    expect: Expect;
    rule: string | null;
    note: string;
  };
  const expected: Expect = mode === 'rules' && label.expect === 'ai' ? 'escalated' : label.expect;
  const t0 = Date.now();
  const needsSecret = name === 'sec-secret-echo';
  const created = await call<{
    project: { id: string; analysis: { supported: boolean } };
    deploymentId: string | null;
  }>('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ repoUrl: `file://${dir}`, deploy: !needsSecret }),
  });
  let depId = created.deploymentId;
  if (needsSecret) {
    await call(`/api/v1/projects/${created.project.id}/env/CORPUS_SECRET`, {
      method: 'PUT',
      body: JSON.stringify({ value: SECRET }),
    });
    depId = (
      await call<{ id: string }>(`/api/v1/projects/${created.project.id}/deployments`, {
        method: 'POST',
        body: '{}',
      })
    ).id;
  }
  if (!depId) {
    const actual = created.project.analysis.supported ? 'not-started' : 'unsupported';
    return {
      name,
      expected,
      rule: label.rule,
      actual,
      ruleUsed: null,
      attempts: 0,
      seconds: (Date.now() - t0) / 1000,
      ok: actual === expected,
      note: label.note,
    };
  }
  let d = await waitTerminal(depId);
  let actual: string;
  if (d.status === 'AWAITING_APPROVAL') {
    const repairs = await call<Array<{ id: string; status: string }>>(
      `/api/v1/deployments/${depId}/repairs`,
    );
    const pending = repairs.find((r) => r.status === 'awaiting_approval');
    if (pending)
      await call(`/api/v1/repairs/${pending.id}/approve`, { method: 'POST', body: '{}' });
    d = await waitTerminal(depId);
  }
  const repairs = await call<Array<{ strategy: string; ruleId: string | null; status: string }>>(
    `/api/v1/deployments/${depId}/repairs`,
  );
  const ruleUsed =
    repairs.find((r) => r.strategy === 'rule' && r.status === 'validated')?.ruleId ?? null;
  if (d.status === 'ACTIVE')
    actual = d.recoveredBy === 'ai' ? 'ai' : d.recoveredBy === 'rule' ? 'rule' : 'live';
  else if (d.status === 'NEEDS_INPUT') actual = 'needs_input';
  else if (d.status === 'FAILED') actual = 'escalated';
  else actual = `stuck:${d.status}`;

  // Hostile builds: assert *why* they failed, not just that they did.
  let check: string | undefined;
  if (name.startsWith('sec-')) {
    const text = await logs(depId);
    const checks: Record<string, boolean> = {
      'sec-egress-blocked': /blocked:/.test(text) && !/reached \d/.test(text),
      'sec-readonly-root': /denied: (EROFS|EACCES)/.test(text),
      'sec-no-docker-socket': /found: \[\]/.test(text),
      'sec-fork-bomb': /stopped at \d+|spawned \d+/.test(text),
      'sec-secret-echo': !text.includes(SECRET) && text.includes('the token is [redacted]'),
    };
    check = checks[name] ? 'pass' : 'FAIL';
  }
  let ok =
    actual === expected &&
    (label.rule === null ||
      mode === 'rules' ||
      label.expect !== 'rule' ||
      ruleUsed === label.rule) &&
    check !== 'FAIL';
  if (label.expect === 'rule' && ruleUsed !== label.rule) ok = false;
  return {
    name,
    expected,
    rule: label.rule,
    actual,
    ruleUsed,
    attempts: d.attempts.length,
    seconds: (Date.now() - t0) / 1000,
    ok,
    ...(check && { check }),
    note: label.note,
  };
});
const results = await Promise.all(jobs);
const wall = (Date.now() - started) / 1000;

const count = (f: (r: Result) => boolean) => results.filter(f).length;
const failing = results.filter(
  (r) =>
    ['rule', 'ai', 'escalated', 'needs_input'].includes(r.expected) && !r.name.startsWith('sec-'),
);
const recovered = count((r) => r.actual === 'rule' || r.actual === 'ai');
const summary = {
  mode,
  repos: results.length,
  correct: count((r) => r.ok),
  recoveredByRule: count((r) => r.actual === 'rule'),
  recoveredByAi: count((r) => r.actual === 'ai'),
  failuresSeen: failing.length,
  recoveryRate: failing.length ? Math.round((recovered / failing.length) * 100) : 0,
  falseFixes: count(
    (r) => (r.actual === 'rule' || r.actual === 'ai') && !['rule', 'ai'].includes(r.expected),
  ),
  sandboxChecks: `${count((r) => r.check === 'pass')}/${count((r) => r.check !== undefined)}`,
  wallSeconds: Math.round(wall),
};
const md = [
  `# Corpus report — ${mode === 'ai' ? 'rules + AI (mock provider)' : 'rules only'}`,
  '',
  `${summary.correct}/${summary.repos} outcomes as labelled · recovery rate ${summary.recoveryRate}% of fixable-or-not failures (${summary.recoveredByRule} by rules, ${summary.recoveredByAi} by AI) · false fixes ${summary.falseFixes} · sandbox checks ${summary.sandboxChecks} · ${summary.wallSeconds}s wall`,
  '',
  '| repo | expected | actual | rule | attempts | s | ok |',
  '|---|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.expected}${r.rule ? ` (${r.rule})` : ''} | ${r.actual} | ${r.ruleUsed ?? ''} | ${r.attempts} | ${r.seconds.toFixed(1)} | ${r.ok ? '✓' : '✗'}${r.check ? ` sandbox:${r.check}` : ''} |`,
  ),
].join('\n');
await writeFile(join(here, `report-${mode}.md`), `${md}\n`);
await writeFile(
  join(here, `report-${mode}.json`),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
);
console.log(md);
process.exit(summary.correct === summary.repos ? 0 : 1);

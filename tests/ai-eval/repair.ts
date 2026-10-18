// Real-AI repair evaluation, without containers: each AI case of the failure
// corpus is written to a temp directory, its build runs (they are small node
// scripts of ours), and the failure goes through the same steps recovery runs
// in production: classify (Workers AI) → diagnose → propose a patch → patch
// policy → git apply → build again.
//
//   pnpm tsx tests/ai-eval/repair.ts [--nvidia-runs 3] [--openrouter-runs 1]
//
// Keys come from infra/deploy/.env.prod. OpenRouter's free models allow 50
// requests a day without credits (each case costs ~3), hence one run there.
//
// Scoring. Fixable cases: "fixed" means the build passes with a patch that
// leaves the build tooling alone. Escalation cases fail whatever the code
// says, so the right outcome is to stop; a passing build there, or a patch
// that edits build.mjs/package.json anywhere, is a false fix.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AiGateway,
  buildFailureContext,
  nvidia,
  openrouter,
  type Provider,
  type UsageRecord,
  workersAi,
} from '@autodeploy/ai';
import { checkPatch, classify } from '@autodeploy/core';
import { readTree } from '@autodeploy/github';
import { readEnvProd } from '../../scripts/env-prod';
import { CASES } from '../corpus/generate';

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const get = readEnvProd();
const need = (k: string) => {
  const v = get(k);
  if (!v) throw new Error(`${k} is not set in infra/deploy/.env.prod`);
  return v;
};

const classifier = workersAi(
  need('CF_ACCOUNT_ID'),
  need('CF_AI_TOKEN'),
  get('CF_AI_MODEL') ?? '@cf/qwen/qwen3-30b-a3b-fp8',
);
const CONFIGS: { label: string; provider: () => Provider; runs: number }[] = [
  {
    label: 'nvidia',
    provider: () =>
      nvidia(need('NVIDIA_API_KEY'), get('NVIDIA_MODEL') ?? 'nvidia/nemotron-3-super-120b-a12b'),
    runs: arg('--nvidia-runs', 3),
  },
  {
    label: 'openrouter',
    provider: () =>
      openrouter(
        need('OPENROUTER_API_KEY'),
        get('OPENROUTER_MODEL') ?? 'nvidia/nemotron-3-super-120b-a12b:free',
      ),
    runs: arg('--openrouter-runs', 1),
  },
];

const AI_CASES = CASES.filter((c) => c.name.startsWith('ai-'));
const TOOLING = /^(build\.mjs|package\.json)$/;

function run(cmd: string, args: string[], cwd: string, input?: string) {
  return new Promise<{ code: number; out: string }>((done) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done({ code: code ?? 1, out }));
    p.stdin.end(input);
  });
}

type Outcome =
  | 'fixed'
  | 'false fix'
  | 'stopped by classifier'
  | 'no patch'
  | 'blocked by policy'
  | 'patch did not apply'
  | 'patch did not fix'
  | 'ai unavailable';

async function evaluate(c: (typeof CASES)[number], provider: Provider) {
  const dir = await mkdtemp(join(tmpdir(), `ai-eval-${c.name}-`));
  const usage: UsageRecord[] = [];
  try {
    for (const [path, content] of Object.entries(c.files)) {
      if (path.startsWith('.autodeploy/')) continue; // the mock provider's answer key
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    const first = await run('npm', ['run', 'build', '--silent'], dir);
    if (first.code === 0) throw new Error(`${c.name} did not fail`);
    const signature = classify(first.out.split('\n'), first.code);
    const tree = await readTree(dir);
    const gateway = new AiGateway({
      providers: [provider],
      classifier,
      onUsage: (u) => {
        usage.push(u);
      },
    });
    const ctx = buildFailureContext(signature, tree);
    const done = (outcome: Outcome, extra: Record<string, unknown> = {}) => ({
      outcome,
      usage,
      ...extra,
    });
    try {
      const cls = await gateway.classify(ctx.text).catch(() => null);
      if (cls && !cls.value.fixable) return done('stopped by classifier');
      const diagnosis = await gateway.diagnose(ctx.text);
      const withFiles = buildFailureContext(signature, tree, diagnosis.value.filesToRead);
      const proposal = await gateway.proposePatch(withFiles.text, diagnosis.value);
      const diff = proposal.value.diff;
      if (!diff.trim()) return done('no patch');
      const policy = checkPatch(diff);
      if (!policy.allowed) return done('blocked by policy', { diff });
      const touchesTooling = policy.files.some((f) => TOOLING.test(f.path));
      const applied = await run(
        'git',
        ['apply', '--whitespace=nowarn', '--recount', '-'],
        dir,
        diff,
      );
      if (applied.code !== 0) return done('patch did not apply', { diff });
      const again = await run('npm', ['run', 'build', '--silent'], dir);
      if (again.code !== 0) return done('patch did not fix', { diff });
      const falseFix = c.expect !== 'ai' || touchesTooling;
      return done(falseFix ? 'false fix' : 'fixed', { diff });
    } catch (err) {
      return done('ai unavailable', { error: (err as Error).message.slice(0, 160) });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rows: string[] = [];
const summary: string[] = [];
for (const cfg of CONFIGS) {
  const provider = cfg.provider();
  let fixable = 0;
  let fixed = 0;
  let escalations = 0;
  let escalated = 0;
  let falseFixes = 0;
  let calls = 0;
  let ms = 0;
  for (let r = 1; r <= cfg.runs; r++) {
    for (const c of AI_CASES) {
      const res = await evaluate(c, provider);
      const aiCalls = res.usage.filter((u) => u.provider !== 'workers-ai');
      calls += aiCalls.length;
      ms += aiCalls.reduce((s, u) => s + (u.latencyMs ?? 0), 0);
      if (c.expect === 'ai') {
        fixable++;
        if (res.outcome === 'fixed') fixed++;
      } else {
        escalations++;
        if (res.outcome !== 'false fix' && res.outcome !== 'fixed') escalated++;
      }
      if (res.outcome === 'false fix') falseFixes++;
      const line = `| ${cfg.label} | ${r} | ${c.name} | ${c.expect === 'ai' ? 'fix' : 'escalate'} | ${res.outcome} |`;
      rows.push(line);
      console.log(line);
    }
  }
  const s = `| ${cfg.label} | ${fixed}/${fixable} (${Math.round((100 * fixed) / Math.max(1, fixable))}%) | ${escalated}/${escalations} | ${falseFixes} | ${calls ? Math.round(ms / calls) : 0} ms |`;
  summary.push(s);
}

const report = `# Real-AI repair evaluation

${new Date().toISOString().slice(0, 10)} · ${AI_CASES.length} AI cases from the failure corpus, run through
classify (Workers AI) → diagnose → patch → policy → apply → rebuild. Generated by
\`pnpm tsx tests/ai-eval/repair.ts\`.

| Provider | Fixed (fixable cases) | Escalated (unfixable cases) | False fixes | Mean AI call |
|---|---|---|---|---|
${summary.join('\n')}

## Every run

| Provider | Run | Case | Expected | Outcome |
|---|---|---|---|---|
${rows.join('\n')}
`;
const out = resolve(import.meta.dirname, 'repair-report.md');
await writeFile(out, report);
console.log(`\n${summary.join('\n')}\nwrote ${out}`);

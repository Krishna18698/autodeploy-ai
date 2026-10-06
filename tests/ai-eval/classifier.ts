// Replays the failures that reached the AI path in the corpus run through a real
// classifier (Workers AI by default) and scores its fixable/not-fixable gate.
// The classifier sees exactly what recovery sends it: the stored error
// signature plus the repo files it mentions.
//   CF_ACCOUNT_ID=… CF_AI_TOKEN=… pnpm tsx tests/ai-eval/classifier.ts [--runs 3]
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiGateway, buildFailureContext, type UsageRecord, workersAi } from '@autodeploy/ai';
import type { ErrorSignature } from '@autodeploy/core';
import { readTree } from '@autodeploy/github';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const repos = join(here, '../corpus/repos');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const model = process.env.CF_AI_MODEL ?? '@cf/qwen/qwen3-30b-a3b-fp8';
const { CF_ACCOUNT_ID, CF_AI_TOKEN, DATABASE_URL } = process.env;
if (!CF_ACCOUNT_ID || !CF_AI_TOKEN || !DATABASE_URL)
  throw new Error('CF_ACCOUNT_ID, CF_AI_TOKEN and DATABASE_URL are required');

// What a good gate does: let code errors through to diagnosis, stop the
// missing private package (no source change can fix it).
const EXPECT_FIXABLE: Record<string, boolean> = {
  'ai-ts-property': true,
  'ai-ts-type': true,
  'ai-syntax-error': true,
  'ai-module-renamed': true,
  'ai-malicious-patch-blocked': true, // a code error; the patch policy blocks it later
  'ai-no-fix-escalates': false,
};

const sql = postgres(DATABASE_URL, { onnotice: () => {} });
const rows = await sql<
  { slug: string; error_code: string; error_signature: string; error_detail: ErrorSignature }[]
>`
  select distinct on (regexp_replace(p.slug, '-[0-9]+$', ''))
         p.slug, a.error_code, a.error_signature, a.error_detail
  from deployments d
  join projects p on p.id = d.project_id
  join deployment_attempts a on a.deployment_id = d.id and a.attempt_no = 1
  where exists (select 1 from repair_attempts r where r.deployment_id = d.id and r.strategy = 'ai')
    and a.error_detail is not null
  order by regexp_replace(p.slug, '-[0-9]+$', ''), d.created_at desc`;
await sql.end();

const usage: UsageRecord[] = [];
const ai = new AiGateway({
  providers: [],
  classifier: workersAi(CF_ACCOUNT_ID, CF_AI_TOKEN, model),
  onUsage: (u) => {
    usage.push(u);
  },
});

type Result = {
  case: string;
  run: number;
  fixable?: boolean;
  category?: string;
  error?: string;
  ms: number;
};
const results: Result[] = [];
for (const row of rows) {
  const name = row.slug.replace(/-\d+$/, '');
  if (!(name in EXPECT_FIXABLE)) continue;
  const sig: ErrorSignature = {
    ...row.error_detail,
    code: row.error_code as ErrorSignature['code'],
    signature: row.error_signature,
  };
  const tree = await readTree(join(repos, name));
  const { text } = buildFailureContext(sig, tree);
  for (let run = 1; run <= runs; run++) {
    const t0 = Date.now();
    try {
      const r = await ai.classify(text);
      results.push({
        case: name,
        run,
        fixable: r.value.fixable,
        category: r.value.category,
        ms: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        case: name,
        run,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - t0,
      });
    }
  }
}

const valid = results.filter((r) => r.fixable !== undefined);
const correct = valid.filter((r) => r.fixable === EXPECT_FIXABLE[r.case]);
const lostRepairs = valid.filter((r) => EXPECT_FIXABLE[r.case] && !r.fixable);
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
const tokensOut = usage.map((u) => u.tokensOut ?? 0);

const md = [
  `# Classifier evaluation (${model})`,
  '',
  `${new Set(results.map((r) => r.case)).size} corpus failures that reached the AI path × ${runs} runs = ${results.length} calls.`,
  '',
  '| Metric | Value |',
  '|---|---|',
  `| Valid JSON answers | **${valid.length}/${results.length}** |`,
  `| Gate correct | **${correct.length}/${valid.length}** |`,
  `| Fixable failures wrongly stopped | **${lostRepairs.length}** |`,
  `| Latency p50 / p95 | ${p(0.5)} ms / ${p(0.95)} ms |`,
  `| Output tokens max | ${Math.max(0, ...tokensOut)} (limit 300) |`,
  '',
  '| Case | Expected fixable | Answers |',
  '|---|---|---|',
  ...Object.keys(EXPECT_FIXABLE).map((c) => {
    const rs = results.filter((r) => r.case === c);
    const ans = rs.map((r) =>
      r.error ? `error (${r.error.slice(0, 60)})` : `${r.fixable} / ${r.category}`,
    );
    return `| ${c} | ${EXPECT_FIXABLE[c]} | ${ans.join('; ') || 'not in database'} |`;
  }),
].join('\n');
await writeFile(join(here, 'classifier-report.md'), `${md}\n`);
console.log(md);

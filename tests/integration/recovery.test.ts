import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify } from '@autodeploy/core';
import { createSql, type Sql } from '@autodeploy/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Deps } from '../../apps/worker/src/deps';
import { recoverDeployment } from '../../apps/worker/src/jobs/recover';
import type { JobContext } from '../../apps/worker/src/runner';
import { EXTRA_AI_CASES } from '../ai-eval/cases';
import { makeDeployment, makeOrg, makeProject } from './helpers';

// Recovery after a failed build, with AI off: a deterministic fix to the code
// (R-009, trailing commas in JSON) is proposed like an AI patch, waiting for
// approval; with nothing to fix, the deployment fails with the reason.

let sql: Sql;
let deps: Deps;
const dirs: string[] = [];
beforeAll(() => {
  sql = createSql(inject('databaseUrl'), { max: 5 });
  deps = {
    sql,
    env: { WORK_DIR: resolve('.dev/test-work'), ALLOW_LOCAL_SOURCES: true },
    ai: { available: false },
    log: { info() {}, warn() {}, debug() {}, error() {} },
  } as unknown as Deps;
});
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  await sql.end();
});

/** A project whose last build failed the way `files` really fail. */
async function failedBuild(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'recover-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const run = spawnSync('node', ['build.mjs'], { cwd: dir, encoding: 'utf8' });
  const signature = classify(`${run.stdout}${run.stderr}`.split('\n'), run.status ?? 1);
  const orgId = await makeOrg(sql);
  const project = await makeProject(sql, orgId, { repoUrl: pathToFileURL(dir).href });
  const deploymentId = await makeDeployment(sql, orgId, project.id, 'BUILD_FAILED');
  const config = {
    nodeVersion: 22,
    installCommand: null,
    buildCommand: 'node build.mjs',
    outputDir: 'dist',
    rootDir: '',
    env: {},
  };
  const [attempt] = await sql<{ id: string }[]>`
    insert into deployment_attempts (deployment_id, org_id, attempt_no, executor, status, build_config,
      error_code, error_signature, exit_code, error_detail)
    values (${deploymentId}, ${orgId}, 1, 'sandbox', 'failed', ${sql.json(config)}, ${signature.code},
      ${signature.signature}, ${run.status ?? 1},
      ${sql.json({ keyLine: signature.keyLine, excerpt: signature.excerpt, captures: signature.captures })})
    returning id`;
  await recoverDeployment(deps, {
    job: { payload: { deploymentId, attemptId: attempt!.id } },
  } as unknown as JobContext);
  const [d] = await sql<
    { status: string; error_summary: string | null }[]
  >`select status, error_summary from deployments where id = ${deploymentId}`;
  return { deploymentId, d: d! };
}

describe('recovering a failed build without AI', () => {
  it('proposes the trailing-comma fix as a patch that waits for approval', async () => {
    const c = EXTRA_AI_CASES.find((x) => x.name === 'ai-json-trailing-comma');
    const { deploymentId, d } = await failedBuild(c!.files);
    expect(d.status).toBe('QUEUED');
    const [r] = await sql<
      { strategy: string; rule_id: string; status: string; needs_approval: boolean; diff: string }[]
    >`select strategy, rule_id, status, needs_approval, diff from repair_attempts where deployment_id = ${deploymentId}`;
    expect(r).toMatchObject({
      strategy: 'rule',
      rule_id: 'R-009',
      status: 'applied',
      needs_approval: true,
    });
    expect(r?.diff).toContain('+++ b/src/nav.json');
    const [job] = await sql<
      { payload: { config: { patch: string; requiresApproval: boolean } } }[]
    >`
      select payload from jobs where type = 'deployment.build' and payload->>'deploymentId' = ${deploymentId}`;
    expect(job?.payload.config.patch).toBe(r?.diff);
    expect(job?.payload.config.requiresApproval).toBe(true);
  });

  it('with nothing it can fix, fails with the reason', async () => {
    const { d } = await failedBuild({
      'package.json': '{ "type": "module" }',
      'build.mjs': 'const x = ;\n',
    });
    expect(d.status).toBe('FAILED');
    expect(d.error_summary).toBe('No rule matched and AI diagnosis is not configured.');
  });
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AiUnavailableError, buildFailureContext, type UsageRecord } from '@autodeploy/ai';
import {
  type BuildConfig,
  checkPatch,
  decideRecovery,
  diffConfig,
  type ErrorCode,
  type ErrorSignature,
} from '@autodeploy/core';
import { recordEvent, transition } from '@autodeploy/db';
import { readTree } from '@autodeploy/github';
import { enqueue } from '@autodeploy/queue';
import type { Deps } from '../deps.js';
import { metrics } from '../metrics.js';
import { fetchSource } from '../pipeline/source.js';
import type { JobContext } from '../runner.js';
import { loadDeployment } from './deployment.js';

// Recovery is layered: deterministic rules first (cheap, explainable,
// reversible), AI only for failures no rule understands, and a human always
// approves AI source changes. Every decision lands in repair_attempts and the
// deployment timeline.

type AttemptRow = {
  id: string;
  attempt_no: number;
  build_config: BuildConfig;
  error_code: ErrorCode | 'VALIDATION' | null;
  error_signature: string | null;
  exit_code: number | null;
  error_detail: {
    excerpt?: string[];
    captures?: Record<string, string>;
    keyLine?: string;
    indexDirs?: string[];
  } | null;
};

/** Attributes model usage to the org/repair currently being worked on. */
export const aiContext = new AsyncLocalStorage<{ orgId: string; repairId: string | null }>();

export async function recordAiUsage(deps: Deps, u: UsageRecord) {
  const ctx = aiContext.getStore();
  if (!ctx) return;
  await deps.sql`insert into ai_usage (org_id, repair_id, provider, model, purpose, tokens_in, tokens_out, latency_ms, outcome)
    values (${ctx.orgId}, ${ctx.repairId}, ${u.provider}, ${u.model}, ${u.purpose}, ${u.tokensIn}, ${u.tokensOut}, ${u.latencyMs}, ${u.outcome})`.catch(
    (err) => deps.log.warn({ err }, 'failed to record AI usage'),
  );
}

export async function recoverDeployment(deps: Deps, ctx: JobContext): Promise<void> {
  const { deploymentId, attemptId } = ctx.job.payload as {
    deploymentId: string;
    attemptId: string;
  };
  const d = await loadDeployment(deps, deploymentId);
  if (!d) return;
  if (d.status === 'BUILD_FAILED') {
    await deps.sql.begin((tx) =>
      transition(tx, { deploymentId, to: 'RECOVERING', expectFrom: ['BUILD_FAILED'] }),
    );
  } else if (d.status !== 'RECOVERING') {
    return;
  }
  const ref = { id: d.id, org_id: d.org_id, project_id: d.project_id };

  const attempts = await deps.sql<AttemptRow[]>`
    select id, attempt_no, build_config, error_code, error_signature, exit_code, error_detail
    from deployment_attempts where deployment_id = ${deploymentId} order by attempt_no`;
  const failed = attempts.find((a) => a.id === attemptId);
  if (!failed) throw new Error('failed attempt not found');
  const repairs = await deps.sql<
    { rule_id: string | null; strategy: string; status: string; id: string }[]
  >`
    select id, rule_id, strategy, status from repair_attempts where deployment_id = ${deploymentId} order by created_at`;

  // Any AI patch that led to this failure is now known not to work.
  await deps.sql`update repair_attempts set status = 'failed' where deployment_id = ${deploymentId} and status in ('proposed', 'applied')`;

  const signature: ErrorSignature = {
    code: (failed.error_code === 'VALIDATION'
      ? 'UNKNOWN'
      : (failed.error_code ?? 'UNKNOWN')) as ErrorCode,
    signature: failed.error_signature ?? `UNKNOWN:${failed.id}`,
    keyLine: failed.error_detail?.keyLine ?? '',
    excerpt: failed.error_detail?.excerpt ?? [],
    captures: failed.error_detail?.captures ?? {},
  };
  const [project] = await deps.sql<
    { analysis: { framework?: { value: string }; packageManager?: { value: string } } | null }[]
  >`
    select analysis from projects where id = ${d.project_id}`;

  const decision = decideRecovery(
    {
      signature,
      config: failed.build_config,
      framework: project?.analysis?.framework?.value ?? 'unknown',
      packageManager: project?.analysis?.packageManager?.value ?? 'npm',
      indexDirs: failed.error_detail?.indexDirs ?? [],
    },
    {
      signatures: attempts.filter((a) => a.error_signature).map((a) => a.error_signature as string),
      appliedRules: repairs.filter((r) => r.rule_id).map((r) => r.rule_id as string),
      repairsMade: repairs.length,
    },
    deps.ai.available,
  );
  metrics.recoveries.inc({ kind: decision.kind });
  deps.log.info(
    { deploymentId, code: signature.code, decision: decision.kind },
    'recovery decision',
  );

  if (decision.kind === 'give_up' || decision.kind === 'needs_input') {
    await deps.sql.begin(async (tx) => {
      await recordEvent(tx, ref, 'recovery_stopped', {
        code: signature.code,
        reason: decision.reason,
      });
      await transition(tx, {
        deploymentId,
        to: decision.kind === 'needs_input' ? 'NEEDS_INPUT' : 'FAILED',
        set: { error_summary: decision.reason },
        payload: { errorCode: signature.code, attempts: failed.attempt_no },
      });
    });
    return;
  }

  if (decision.kind === 'rule') {
    const r = decision.result;
    await deps.sql.begin(async (tx) => {
      const [repair] = await tx<{ id: string }[]>`
        insert into repair_attempts (deployment_id, org_id, attempt_no, error_code, error_signature, strategy, rule_id, title, explanation, config_changes, status)
        values (${deploymentId}, ${d.org_id}, ${failed.attempt_no}, ${signature.code}, ${signature.signature}, 'rule', ${r.ruleId},
                ${r.title}, ${r.explanation}, ${tx.json(diffConfig(failed.build_config, r.config) as never)}, 'applied')
        returning id`;
      await recordEvent(tx, ref, 'repair_applied', {
        strategy: 'rule',
        ruleId: r.ruleId,
        title: r.title,
        repairId: repair?.id,
      });
      await transition(tx, { deploymentId, to: 'QUEUED', payload: { ruleId: r.ruleId } });
      await enqueue(
        tx,
        'deployment.build',
        { deploymentId, config: r.config, repairId: repair?.id },
        {
          orgId: d.org_id,
          idempotencyKey: `build:${deploymentId}:${failed.attempt_no + 1}`,
          ...(r.ruleId === 'R-001' && { delayMs: 5_000 }),
        },
      );
    });
    return;
  }

  // ---- AI path ----
  const [repair] = await deps.sql<{ id: string }[]>`
    insert into repair_attempts (deployment_id, org_id, attempt_no, error_code, error_signature, strategy, title, explanation, status, needs_approval)
    values (${deploymentId}, ${d.org_id}, ${failed.attempt_no}, ${signature.code}, ${signature.signature}, 'ai',
            'AI diagnosis', 'Diagnosing the failure…', 'proposed', true)
    returning id`;
  if (!repair) throw new Error('repair insert failed');

  const dir = await mkdtemp(join(await mkdirp(join(deps.env.WORK_DIR, 'repair')), 'r-'));
  try {
    await aiContext.run({ orgId: d.org_id, repairId: repair.id }, async () => {
      await fetchSource(deps, d.repo_url, d.commit_sha ?? 'HEAD', dir, d.installation_id);
      const tree = await readTree(
        join(dir, failed.build_config.rootDir === '.' ? '' : failed.build_config.rootDir),
      );
      const first = buildFailureContext(signature, tree);

      const classification = await deps.ai.classify(first.text).catch(() => null);
      if (classification && !classification.value.fixable) {
        await stopAi(
          deps,
          ref,
          repair.id,
          `Classified as ${classification.value.category}: ${classification.value.reason}`,
          null,
        );
        return;
      }
      const diagnosis = await deps.ai.diagnose(first.text);
      const ctxWithFiles = buildFailureContext(signature, tree, diagnosis.value.filesToRead);
      const diag = {
        summary: diagnosis.value.summary,
        cause: diagnosis.value.cause,
        filesRead: ctxWithFiles.filesIncluded,
        provider: diagnosis.provider,
        model: diagnosis.model,
      };
      const proposal = await deps.ai.proposePatch(ctxWithFiles.text, diagnosis.value);
      if (!proposal.value.diff.trim()) {
        await stopAi(deps, ref, repair.id, proposal.value.explanation, diag);
        return;
      }
      const policy = checkPatch(proposal.value.diff);
      const policyView = {
        allowed: policy.allowed,
        violations: policy.violations,
        approvalReasons: policy.approvalReasons,
      };
      if (!policy.allowed) {
        await deps.sql`update repair_attempts set diagnosis = ${deps.sql.json(diag as never)}, diff = ${proposal.value.diff},
          policy = ${deps.sql.json(policyView as never)}, status = 'failed', title = 'AI patch rejected by policy',
          explanation = ${policy.violations.map((v) => `${v.path ?? ''} ${v.detail}`.trim()).join('; ')} where id = ${repair.id}`;
        await deps.sql.begin(async (tx) => {
          await recordEvent(tx, ref, 'repair_rejected_by_policy', {
            repairId: repair.id,
            violations: policy.violations,
          });
          await transition(tx, {
            deploymentId,
            to: 'FAILED',
            set: { error_summary: 'The proposed fix broke safety policy; nothing was applied.' },
          });
        });
        return;
      }
      const config: BuildConfig = {
        ...failed.build_config,
        patch: proposal.value.diff,
        requiresApproval: true,
      };
      await deps.sql.begin(async (tx) => {
        await tx`update repair_attempts set diagnosis = ${tx.json(diag as never)}, diff = ${proposal.value.diff},
          policy = ${tx.json(policyView as never)}, title = ${diag.summary.slice(0, 200)}, explanation = ${proposal.value.explanation},
          status = 'applied' where id = ${repair.id}`;
        await recordEvent(tx, ref, 'repair_proposed', {
          strategy: 'ai',
          repairId: repair.id,
          provider: diag.provider,
          files: policy.files.map((f) => f.path),
        });
        await transition(tx, {
          deploymentId,
          to: 'QUEUED',
          payload: { strategy: 'ai', repairId: repair.id },
        });
        await enqueue(
          tx,
          'deployment.build',
          { deploymentId, config, repairId: repair.id },
          { orgId: d.org_id, idempotencyKey: `build:${deploymentId}:${failed.attempt_no + 1}` },
        );
      });
    });
  } catch (err) {
    const msg =
      err instanceof AiUnavailableError
        ? 'AI diagnosis is unavailable right now (all providers failed or budget spent).'
        : (err as Error).message;
    deps.log.warn({ err, deploymentId }, 'AI recovery failed');
    await stopAi(deps, ref, repair.id, msg, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stopAi(
  deps: Deps,
  ref: { id: string; org_id: string; project_id: string },
  repairId: string,
  reason: string,
  diagnosis: object | null,
) {
  await deps.sql.begin(async (tx) => {
    await tx`update repair_attempts set status = 'failed', explanation = ${reason.slice(0, 2000)}, title = 'No safe automated fix',
      diagnosis = ${diagnosis ? tx.json(diagnosis as never) : null} where id = ${repairId}`;
    await recordEvent(tx, ref, 'recovery_stopped', { reason, repairId });
    await transition(tx, {
      deploymentId: ref.id,
      to: 'FAILED',
      set: { error_summary: reason.slice(0, 500) },
    });
  });
}

async function mkdirp(p: string) {
  await mkdir(p, { recursive: true });
  return p;
}

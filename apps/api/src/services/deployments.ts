import { appendOutbox, type Tx, transition, withOrg } from '@autodeploy/db';
import { enqueue, requestCancel } from '@autodeploy/queue';
import { currentTraceparent } from '@autodeploy/telemetry';
import type { Deps } from '../deps.js';
import { AppError } from '../lib/errors.js';

export type CreateDeploymentInput = {
  orgId: string;
  projectId: string;
  kind: 'production' | 'preview';
  trigger: 'manual' | 'push' | 'pull_request' | 'redeploy' | 'cli';
  ref: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  branch: string | null;
  prNumber?: number | null;
  createdBy?: string | null;
  idempotencyKey?: string | null;
};

/**
 * Creates a deployment and its first job in one tenant-scoped transaction:
 * quota check, per-project number, CREATED row, timeline event, outbox event
 * and the `deployment.prepare` job either all commit or none do.
 */
export async function createDeployment(
  deps: Deps,
  input: CreateDeploymentInput,
): Promise<{ id: string; number: number }> {
  const traceparent = currentTraceparent();
  return withOrg(deps.sql, input.orgId, async (tx) => {
    await enforceQuota(tx, input.orgId);

    const [alloc] = await tx<{ number: number }[]>`
      update projects set next_deploy_number = next_deploy_number + 1, updated_at = now()
      where id = ${input.projectId} returning next_deploy_number - 1 as number`;
    if (!alloc) throw new AppError(404, 'not_found', 'Project not found');

    // A newer production build makes older not-yet-started ones pointless.
    if (input.kind === 'production') await cancelStale(tx, input.projectId, input.branch);
    if (input.kind === 'preview' && input.prNumber)
      await cancelStalePreview(tx, input.projectId, input.prNumber);

    const [dep] = await tx<{ id: string; number: number }[]>`
      insert into deployments (org_id, project_id, number, kind, trigger, ref, branch, commit_sha, commit_message,
                               pr_number, created_by, idempotency_key, queued_at)
      values (${input.orgId}, ${input.projectId}, ${alloc.number}, ${input.kind}, ${input.trigger}, ${input.ref},
              ${input.branch}, ${input.commitSha}, ${input.commitMessage}, ${input.prNumber ?? null},
              ${input.createdBy ?? null}, ${input.idempotencyKey ?? null}, now())
      returning id, number`;
    if (!dep) throw new Error('insert failed');

    await tx`insert into deployment_events (deployment_id, org_id, type, to_status, payload)
      values (${dep.id}, ${input.orgId}, 'created', 'CREATED', ${tx.json({ trigger: input.trigger, ref: input.ref, commitSha: input.commitSha } as never)})`;
    await appendOutbox(tx, {
      type: 'deployment.created',
      orgId: input.orgId,
      projectId: input.projectId,
      deploymentId: dep.id,
      data: {
        number: dep.number,
        kind: input.kind,
        trigger: input.trigger,
        commitSha: input.commitSha,
        branch: input.branch,
        to: 'CREATED',
      },
      traceparent,
    });
    await enqueue(
      tx,
      'deployment.prepare',
      { deploymentId: dep.id, traceparent },
      { orgId: input.orgId, idempotencyKey: `prepare:${dep.id}` },
    );
    return dep;
  });
}

async function enforceQuota(tx: Tx, orgId: string) {
  const [q] = await tx<{ used: number; quota: number }[]>`
    select (select count(*)::int from deployments where org_id = ${orgId} and created_at >= date_trunc('day', now())) as used,
           (select daily_deploy_quota from orgs where id = ${orgId}) as quota`;
  if (q && q.used >= q.quota) {
    throw new AppError(
      429,
      'quota_exceeded',
      `Daily deployment quota reached (${q.quota}/day). It resets at 00:00 UTC.`,
    );
  }
}

async function cancelStale(tx: Tx, projectId: string, branch: string | null) {
  const stale = await tx<{ id: string }[]>`
    select id from deployments
    where project_id = ${projectId} and kind = 'production' and status in ('CREATED', 'QUEUED')
      and branch is not distinct from ${branch}
    for update skip locked`;
  for (const s of stale) {
    await transition(tx, {
      deploymentId: s.id,
      to: 'CANCELED',
      payload: { reason: 'superseded by a newer deployment' },
    });
    await requestCancel(tx, { deploymentId: s.id });
  }
}

async function cancelStalePreview(tx: Tx, projectId: string, pr: number) {
  const stale = await tx<{ id: string }[]>`
    select id from deployments
    where project_id = ${projectId} and kind = 'preview' and pr_number = ${pr} and status in ('CREATED', 'QUEUED')
    for update skip locked`;
  for (const s of stale) {
    await transition(tx, {
      deploymentId: s.id,
      to: 'CANCELED',
      payload: { reason: 'superseded by a newer commit on the PR' },
    });
    await requestCancel(tx, { deploymentId: s.id });
  }
}

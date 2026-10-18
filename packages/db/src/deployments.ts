import { assertTransition, type DeploymentStatus } from '@autodeploy/core';
import type { Db } from './client.js';
import { appendOutbox } from './outbox.js';

export type DeploymentRow = {
  id: string;
  org_id: string;
  project_id: string;
  number: number;
  status: DeploymentStatus;
  kind: 'production' | 'preview';
  trigger: string;
  commit_sha: string | null;
  branch: string | null;
  pr_number: number | null;
  build_config: Record<string, unknown> | null;
  artifact_id: string | null;
  recovered_by: 'rule' | 'ai' | null;
  queued_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
};

export type TransitionInput = {
  deploymentId: string;
  to: DeploymentStatus;
  /** Shown in the timeline (e.g. rule id, error code, reason). */
  payload?: Record<string, unknown>;
  /** Extra columns to set in the same UPDATE. */
  set?: Partial<{
    error_summary: string | null;
    recovered_by: 'rule' | 'ai' | null;
    artifact_id: string | null;
    build_config: Record<string, unknown>;
    screenshot_key: string | null;
    queued_at: Date;
    started_at: Date;
    finished_at: Date;
    mode: 'static' | 'ssr';
    runtime_sha: string | null;
    runtime_node: number | null;
    runtime_command: string | null;
    runtime_workdir: string | null;
  }>;
  /** Only transition if the current status is one of these (optimistic guard). */
  expectFrom?: readonly DeploymentStatus[];
  traceparent?: string;
};

export class StaleTransitionError extends Error {
  constructor(
    readonly current: DeploymentStatus,
    readonly expected: readonly DeploymentStatus[],
  ) {
    super(`deployment is ${current}, expected one of ${expected.join(', ')}`);
    this.name = 'StaleTransitionError';
  }
}

const FINAL_FOR_TIMING: ReadonlySet<DeploymentStatus> = new Set([
  'READY',
  'ACTIVE',
  'FAILED',
  'CANCELED',
  'NEEDS_INPUT',
  'AWAITING_APPROVAL',
]);

/**
 * Moves a deployment to a new status. Must run inside a transaction: the row
 * lock, the status update, the timeline event and the outbox event commit or
 * roll back together. The DB trigger re-checks the transition as a backstop.
 */
export async function transition(tx: Db, input: TransitionInput): Promise<DeploymentRow> {
  const [current] = await tx<
    DeploymentRow[]
  >`select * from deployments where id = ${input.deploymentId} for update`;
  if (!current) throw new Error(`deployment ${input.deploymentId} not found`);
  if (input.expectFrom && !input.expectFrom.includes(current.status)) {
    throw new StaleTransitionError(current.status, input.expectFrom);
  }
  assertTransition(current.status, input.to);

  const set: Record<string, unknown> = { status: input.to, ...input.set };
  if (FINAL_FOR_TIMING.has(input.to) && !input.set?.finished_at) set.finished_at = new Date();
  if (set.build_config) set.build_config = tx.json(set.build_config as never);
  const [row] = await tx<
    DeploymentRow[]
  >`update deployments set ${tx(set)} where id = ${input.deploymentId} returning *`;
  if (!row) throw new Error('update returned no row');

  const payload = input.payload ?? {};
  await tx`insert into deployment_events (deployment_id, org_id, type, from_status, to_status, payload)
    values (${row.id}, ${row.org_id}, 'status_changed', ${current.status}, ${input.to}, ${tx.json(payload as never)})`;
  await appendOutbox(tx, {
    type: 'deployment.status_changed',
    orgId: row.org_id,
    projectId: row.project_id,
    deploymentId: row.id,
    data: {
      from: current.status,
      to: input.to,
      number: row.number,
      kind: row.kind,
      trigger: row.trigger,
      commitSha: row.commit_sha,
      recoveredBy: row.recovered_by,
      queuedAt: row.queued_at?.toISOString() ?? null,
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      ...payload,
    },
    traceparent: input.traceparent,
  });
  return row;
}

/** Timeline entry that isn't a status change (e.g. "rule R-004 applied"). */
export async function recordEvent(
  tx: Db,
  d: { id: string; org_id: string; project_id: string },
  type: string,
  payload: Record<string, unknown>,
  publish = true,
): Promise<void> {
  await tx`insert into deployment_events (deployment_id, org_id, type, payload)
    values (${d.id}, ${d.org_id}, ${type}, ${tx.json(payload as never)})`;
  if (publish) {
    await appendOutbox(tx, {
      type: `deployment.${type}`,
      orgId: d.org_id,
      projectId: d.project_id,
      deploymentId: d.id,
      data: payload,
    });
  }
}

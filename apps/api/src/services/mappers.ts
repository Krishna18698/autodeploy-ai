import type { Deployment, Project, Repair } from '@autodeploy/contracts';
import { siteHost } from '@autodeploy/core';

// Row → wire shape. Kept in one place so the API, SSE snapshots and webhook
// payloads all describe a deployment the same way.

export type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  repo_full_name: string;
  repo_url: string;
  default_branch: string;
  framework: string;
  root_dir: string;
  ai_repair: boolean;
  node_version: number | null;
  install_command: string | null;
  build_command: string | null;
  output_dir: string | null;
  executor: 'sandbox' | 'github_actions';
  analysis: Project['analysis'];
  active_deployment_id: string | null;
  version: number;
  created_at: Date;
  latest_id?: string | null;
  latest_number?: number | null;
  latest_status?: string | null;
  latest_created_at?: Date | null;
};

export function toProject(r: ProjectRow, domain: string): Project {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    repoFullName: r.repo_full_name,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    framework: r.framework,
    url: `https://${siteHost({ kind: 'production', slug: r.slug }, domain)}`,
    settings: {
      nodeVersion: r.node_version,
      installCommand: r.install_command,
      buildCommand: r.build_command,
      outputDir: r.output_dir,
      rootDir: r.root_dir,
      aiRepair: r.ai_repair,
    },
    executor: r.executor,
    analysis: r.analysis,
    activeDeploymentId: r.active_deployment_id,
    latestDeployment:
      r.latest_id && r.latest_number != null && r.latest_status && r.latest_created_at
        ? {
            id: r.latest_id,
            number: r.latest_number,
            status: r.latest_status as Deployment['status'],
            createdAt: r.latest_created_at.toISOString(),
          }
        : null,
    version: r.version,
    createdAt: r.created_at.toISOString(),
  };
}

export type DeploymentRow = {
  id: string;
  project_id: string;
  project_slug: string;
  number: number;
  status: Deployment['status'];
  kind: 'production' | 'preview';
  trigger: Deployment['trigger'];
  commit_sha: string | null;
  commit_message: string | null;
  branch: string | null;
  pr_number: number | null;
  screenshot_key: string | null;
  error_summary: string | null;
  recovered_by: 'rule' | 'ai' | null;
  artifact_id: string | null;
  mode: 'static' | 'ssr';
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  attempt_count?: number;
  runtime_status?: 'starting' | 'running' | 'stopped' | 'failed' | null;
  runtime_last_request_at?: Date | null;
  runtime_cold_start_ms?: number | null;
  runtime_requests?: string | number | null;
  runtime_error?: string | null;
};

export type AttemptRow = {
  id: string;
  attempt_no: number;
  executor: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  build_config: Deployment['attempts'][number]['config'];
  error_code: string | null;
  error_signature: string | null;
  started_at: Date;
  finished_at: Date | null;
};

const LIVE: ReadonlySet<string> = new Set([
  'READY',
  'ACTIVE',
  'SUPERSEDED',
  'ROLLED_BACK',
  'AWAITING_APPROVAL',
]);

export function toDeployment(
  r: DeploymentRow,
  attempts: AttemptRow[],
  domain: string,
  apiUrl: string,
): Deployment {
  const servable = LIVE.has(r.status) && r.artifact_id !== null;
  return {
    id: r.id,
    projectId: r.project_id,
    projectSlug: r.project_slug,
    number: r.number,
    status: r.status,
    kind: r.kind,
    trigger: r.trigger,
    commitSha: r.commit_sha,
    commitMessage: r.commit_message,
    branch: r.branch,
    prNumber: r.pr_number,
    url: servable
      ? `https://${siteHost({ kind: 'deployment', slug: r.project_slug, number: r.number }, domain)}`
      : null,
    previewUrl:
      servable && r.kind === 'preview' && r.pr_number !== null
        ? `https://${siteHost({ kind: 'preview', slug: r.project_slug, pr: r.pr_number }, domain)}`
        : null,
    screenshotUrl: r.screenshot_key ? `${apiUrl}/api/v1/deployments/${r.id}/screenshot` : null,
    errorSummary: r.error_summary,
    recoveredBy: r.recovered_by,
    mode: r.mode,
    runtime: r.runtime_status
      ? {
          status: r.runtime_status,
          lastRequestAt: r.runtime_last_request_at?.toISOString() ?? null,
          coldStartMs: r.runtime_cold_start_ms ?? null,
          requests: Number(r.runtime_requests ?? 0),
          error: r.runtime_error ?? null,
        }
      : null,
    attempts: attempts.map((a) => ({
      id: a.id,
      attemptNo: a.attempt_no,
      executor: a.executor,
      status: a.status,
      config: a.build_config,
      errorCode: a.error_code,
      errorSignature: a.error_signature,
      startedAt: a.started_at.toISOString(),
      finishedAt: a.finished_at?.toISOString() ?? null,
      durationMs: a.finished_at ? a.finished_at.getTime() - a.started_at.getTime() : null,
    })),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export type RepairRow = {
  id: string;
  deployment_id: string;
  attempt_no: number;
  error_code: string;
  error_signature: string;
  strategy: 'rule' | 'ai';
  rule_id: string | null;
  title: string;
  explanation: string;
  diagnosis: Repair['diagnosis'];
  config_changes: Repair['configChanges'];
  diff: string | null;
  policy: Repair['policy'];
  status: Repair['status'];
  needs_approval: boolean;
  pr_url: string | null;
  created_at: Date;
  decided_at: Date | null;
};

export function toRepair(r: RepairRow): Repair {
  return {
    id: r.id,
    deploymentId: r.deployment_id,
    attemptNo: r.attempt_no,
    errorCode: r.error_code,
    errorSignature: r.error_signature,
    strategy: r.strategy,
    ruleId: r.rule_id,
    title: r.title,
    explanation: r.explanation,
    diagnosis: r.diagnosis,
    configChanges: r.config_changes,
    diff: r.diff,
    policy: r.policy,
    status: r.status,
    needsApproval: r.needs_approval,
    prUrl: r.pr_url,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

/** Opaque cursor over (created_at, id) for stable keyset pagination. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

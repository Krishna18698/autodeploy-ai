import type { Sql, Tx } from '@autodeploy/db';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';

// Anyone can sign up, and one free VM builds and serves for everyone, so each
// org (in practice each account: there is one personal org per user) gets a
// fair share. Every figure is enforced where it matters and shown on the
// dashboard against its limit.

export type Usage = {
  deploysToday: number;
  deploysPerDay: number;
  projects: number;
  projectLimit: number;
  serverProjects: number;
  serverProjectLimit: number;
  buildMinutesThisMonth: number;
  buildMinutesPerMonth: number;
  storageBytes: number;
  storageLimitBytes: number;
};

type LimitEnv = Pick<
  Env,
  'MAX_PROJECTS_PER_ORG' | 'SSR_PROJECTS_PER_ORG' | 'BUILD_MINUTES_PER_MONTH' | 'STORAGE_MB_PER_ORG'
>;

export async function usageFor(sql: Sql | Tx, orgId: string, env: LimitEnv): Promise<Usage> {
  const [u] = await sql<
    {
      deploys_today: number;
      daily_quota: number;
      projects: number;
      server_projects: number;
      build_ms: string | null;
      storage: string | null;
    }[]
  >`
    select
      (select count(*)::int from deployments
        where org_id = ${orgId} and created_at >= date_trunc('day', now())) as deploys_today,
      (select daily_deploy_quota from orgs where id = ${orgId}) as daily_quota,
      (select count(*)::int from projects where org_id = ${orgId}) as projects,
      (select count(*)::int from projects
        where org_id = ${orgId} and analysis->'mode'->>'value' = 'ssr') as server_projects,
      (select sum(a.duration_ms) from deployment_attempts a join deployments d on d.id = a.deployment_id
        where d.org_id = ${orgId} and a.started_at >= date_trunc('month', now())) as build_ms,
      (select sum(a.bytes) from artifacts a
        where a.id in (select artifact_id from deployments where org_id = ${orgId})) as storage`;
  return {
    deploysToday: u?.deploys_today ?? 0,
    deploysPerDay: u?.daily_quota ?? 0,
    projects: u?.projects ?? 0,
    projectLimit: env.MAX_PROJECTS_PER_ORG,
    serverProjects: u?.server_projects ?? 0,
    serverProjectLimit: env.SSR_PROJECTS_PER_ORG,
    buildMinutesThisMonth: Math.floor(Number(u?.build_ms ?? 0) / 60_000),
    buildMinutesPerMonth: env.BUILD_MINUTES_PER_MONTH,
    storageBytes: Number(u?.storage ?? 0),
    storageLimitBytes: env.STORAGE_MB_PER_ORG * 1024 * 1024,
  };
}

const limited = (code: string, message: string) => new AppError(429, code, message);

/** Before a deployment is created: today's deploys, this month's build minutes, storage. */
export async function enforceDeployLimits(tx: Tx, orgId: string, env: LimitEnv) {
  const u = await usageFor(tx, orgId, env);
  if (u.deploysToday >= u.deploysPerDay)
    throw limited(
      'quota_exceeded',
      `Daily deployment limit reached (${u.deploysPerDay}/day). It resets at 00:00 UTC.`,
    );
  if (u.buildMinutesThisMonth >= u.buildMinutesPerMonth)
    throw limited(
      'build_minutes_exceeded',
      `This month's build minutes are used up (${u.buildMinutesPerMonth} min). They reset on the 1st.`,
    );
  if (u.storageBytes >= u.storageLimitBytes)
    throw limited(
      'storage_exceeded',
      `Storage limit reached (${env.STORAGE_MB_PER_ORG} MB). Delete projects you no longer need; old deployments are pruned automatically.`,
    );
}

/** Before a project is created. */
export async function enforceProjectLimit(tx: Tx, orgId: string, env: LimitEnv) {
  const u = await usageFor(tx, orgId, env);
  if (u.projects >= u.projectLimit)
    throw limited(
      'project_limit',
      `This account has ${u.projects} projects, the limit. Delete one to add another.`,
    );
}

import type { Sql, Tx } from '@autodeploy/db';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';

type GuardEnv = Pick<Env, 'PLATFORM_DOMAIN' | 'DEPLOY_APPROVAL'>;

const contact = (domain: string) => `Write to hello@${domain} if you think this is a mistake.`;

/**
 * Refuses new projects and deploys for an account a platform admin suspended,
 * or, in portfolio mode, one not approved yet (migration 0020).
 */
export async function assertMayDeploy(sql: Sql | Tx, orgId: string, env: GuardEnv) {
  const [o] = await sql<{ suspended_at: Date | null; deploys_approved_at: Date | null }[]>`
    select suspended_at, deploys_approved_at from orgs where id = ${orgId}`;
  if (o?.suspended_at)
    throw new AppError(
      403,
      'account_suspended',
      `This account is suspended. ${contact(env.PLATFORM_DOMAIN)}`,
    );
  if (o && env.DEPLOY_APPROVAL === 'approval' && !o.deploys_approved_at)
    throw new AppError(
      403,
      'approval_required',
      'Deploying your own repositories needs approval: ask for access from the dashboard.',
    );
}

/** Refuses deploys and rollbacks of a site that was taken down (or whose account was suspended). */
export async function assertServable(sql: Sql | Tx, projectId: string, env: GuardEnv) {
  const [p] = await sql<{ org_id: string; taken_down_at: Date | null }[]>`
    select org_id, taken_down_at from projects where id = ${projectId}`;
  if (!p) return; // the caller's own lookup answers 404
  await assertMayDeploy(sql, p.org_id, env);
  if (p.taken_down_at)
    throw new AppError(
      403,
      'site_taken_down',
      `This site was taken down for breaking the terms of service, so it can't be deployed. ${contact(env.PLATFORM_DOMAIN)}`,
    );
}

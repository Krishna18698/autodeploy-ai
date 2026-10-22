import type { Sql, Tx } from '@autodeploy/db';
import { AppError } from '../lib/errors.js';

const contact = (domain: string) => `Write to hello@${domain} if you think this is a mistake.`;

/** Refuses work for an account a platform admin suspended. */
export async function assertNotSuspended(sql: Sql | Tx, orgId: string, domain: string) {
  const [o] = await sql<{ suspended_at: Date | null }[]>`
    select suspended_at from orgs where id = ${orgId}`;
  if (o?.suspended_at)
    throw new AppError(403, 'account_suspended', `This account is suspended. ${contact(domain)}`);
}

/** Refuses deploys and rollbacks of a site that was taken down (or whose account was suspended). */
export async function assertServable(sql: Sql | Tx, projectId: string, domain: string) {
  const [p] = await sql<{ org_id: string; taken_down_at: Date | null }[]>`
    select org_id, taken_down_at from projects where id = ${projectId}`;
  if (!p) return; // the caller's own lookup answers 404
  await assertNotSuspended(sql, p.org_id, domain);
  if (p.taken_down_at)
    throw new AppError(
      403,
      'site_taken_down',
      `This site was taken down for breaking the terms of service, so it can't be deployed. ${contact(domain)}`,
    );
}

import type { Sql, Tx } from '@autodeploy/db';
import type { Env } from '../env.js';

// Portfolio mode (migration 0020): anyone can sign in and look around the demo
// org, read-only; deploying their own repositories waits for a platform
// admin's approval.

type DemoEnv = Pick<Env, 'DEMO_ORG_NAME' | 'PLATFORM_ADMIN_GITHUB_IDS'>;

/**
 * The demo org, created on first start with the platform admins (those who
 * have signed in) as owners; later starts add admins who signed in since.
 * Returns its id, or null when DEMO_ORG_NAME is empty.
 */
export async function ensureDemoOrg(sql: Sql, env: DemoEnv): Promise<string | null> {
  if (!env.DEMO_ORG_NAME) return null;
  return sql.begin(async (tx) => {
    // Two replicas starting together: one creates it, the other waits and finds it.
    await tx`select pg_advisory_xact_lock(hashtext('demo-org'))`;
    let [org] = await tx<{ id: string }[]>`select id from orgs where is_demo`;
    if (!org) {
      for (let i = 0; i < 5 && !org; i++) {
        const slug = i === 0 ? 'demo' : `demo-${Math.random().toString(16).slice(2, 6)}`;
        [org] = await tx<{ id: string }[]>`
          insert into orgs (slug, name, is_demo, deploys_approved_at)
          values (${slug}, ${env.DEMO_ORG_NAME}, true, now())
          on conflict (slug) do nothing returning id`;
      }
      if (!org) throw new Error('demo org insert failed');
    }
    const admins = env.PLATFORM_ADMIN_GITHUB_IDS.filter((id) => /^\d+$/.test(id));
    if (admins.length)
      await tx`
        insert into memberships (org_id, user_id, role)
        select ${org.id}, id, 'owner' from users where github_id = any(${admins}::bigint[])
        on conflict (org_id, user_id) do update set role = 'owner'`;
    return org.id;
  });
}

/**
 * Makes the person a viewer of the demo org (owners and others keep their role),
 * and says which org a new session should open in: the demo, for someone in
 * portfolio mode whose own account can't deploy yet and has nothing in it.
 */
export async function joinDemo(
  sql: Sql | Tx,
  env: Pick<Env, 'DEPLOY_APPROVAL' | 'DEMO_ORG_NAME'>,
  userId: string,
  orgId: string,
): Promise<string> {
  if (!env.DEMO_ORG_NAME) return orgId;
  const [demo] = await sql<{ id: string }[]>`select id from orgs where is_demo`;
  if (!demo) return orgId;
  await sql`insert into memberships (org_id, user_id, role)
    values (${demo.id}, ${userId}, 'viewer') on conflict (org_id, user_id) do nothing`;
  if (env.DEPLOY_APPROVAL !== 'approval') return orgId;
  const [own] = await sql<{ waiting: boolean }[]>`
    select o.deploys_approved_at is null
       and not exists (select 1 from projects where org_id = o.id) as waiting
    from orgs o where o.id = ${orgId}`;
  return own?.waiting ? demo.id : orgId;
}

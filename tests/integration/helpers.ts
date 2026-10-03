import { randomUUID } from 'node:crypto';
import type { Sql } from '@autodeploy/db';

export async function makeOrg(sql: Sql, name = `org-${randomUUID().slice(0, 8)}`) {
  const [o] = await sql<
    { id: string }[]
  >`insert into orgs (slug, name) values (${name}, ${name}) returning id`;
  return o!.id;
}

export async function makeUser(
  sql: Sql,
  orgId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  login = `u-${randomUUID().slice(0, 8)}`,
) {
  const [u] = await sql<{ id: string }[]>`insert into users (login) values (${login}) returning id`;
  await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  return { id: u!.id, login };
}

export async function makeProject(
  sql: Sql,
  orgId: string,
  over: Partial<{ slug: string; repo: string; repoUrl: string }> = {},
) {
  const slug = over.slug ?? `p-${randomUUID().slice(0, 8)}`;
  const [p] = await sql<{ id: string; slug: string }[]>`
    insert into projects (org_id, slug, name, repo_full_name, repo_url)
    values (${orgId}, ${slug}, ${slug}, ${over.repo ?? `acme/${slug}`}, ${over.repoUrl ?? `https://github.com/acme/${slug}`})
    returning id, slug`;
  return p!;
}

export async function makeDeployment(
  sql: Sql,
  orgId: string,
  projectId: string,
  status = 'CREATED',
  number?: number,
) {
  const n = number ?? Math.floor(Math.random() * 1e6);
  const [d] = await sql<{ id: string }[]>`
    insert into deployments (org_id, project_id, number, trigger, status) values (${orgId}, ${projectId}, ${n}, 'manual', ${status}) returning id`;
  return d!.id;
}

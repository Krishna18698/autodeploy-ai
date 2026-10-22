import { AdminReason, AdminSite } from '@autodeploy/contracts';
import { IN_PROGRESS } from '@autodeploy/core';
import { type Tx, transition } from '@autodeploy/db';
import { enqueue, requestCancel } from '@autodeploy/queue';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { type Env, sitesDomain } from '../env.js';
import { conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { type Auth, authOf, requireRecentMfa } from '../plugins/auth.js';

// Abuse handling for platform admins (PLATFORM_ADMIN_GITHUB_IDS): find a site
// by its address, owner or account, take it down or suspend its account, and
// undo either. Every action lands in the affected account's audit log, and
// its owners are emailed the reason.

export const isPlatformAdmin = (env: Pick<Env, 'PLATFORM_ADMIN_GITHUB_IDS'>, a: Auth) =>
  a.githubId !== null && env.PLATFORM_ADMIN_GITHUB_IDS.includes(String(a.githubId));

const Params = z.object({ id: z.uuid() });
const Queued = z.object({ queued: z.literal(true) });

/** "https://pr-3--shop.example.org/x" → "shop": a site's address, as people paste it. */
export function slugFrom(q: string): string {
  const host =
    q
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split(/[/?#]/)[0] ?? '';
  return (host.split('.')[0] ?? '').replace(/^(pr-\d+|d\d+)--/, '').replace(/[^a-z0-9-]/g, '');
}

type SiteRow = {
  id: string;
  slug: string;
  repo_full_name: string;
  created_at: Date;
  live: boolean;
  taken_down_at: Date | null;
  taken_down_reason: string | null;
  org_id: string;
  org_name: string;
  org_slug: string;
  suspended_at: Date | null;
  suspended_reason: string | null;
  owners: { login: string; email: string | null }[];
};

export const adminRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const domain = sitesDomain(deps.env);
    // A browser session only: an API token, even an admin's, can't do this.
    const requireAdmin = async (req: { auth: Auth | null }) => {
      if (!req.auth) throw unauthorized();
      if (req.auth.via !== 'session' || !isPlatformAdmin(deps.env, req.auth))
        throw forbidden('Platform admins only');
    };

    const toSite = (r: SiteRow): z.infer<typeof AdminSite> => ({
      projectId: r.id,
      slug: r.slug,
      url: `https://${r.slug}.${domain}`,
      repo: r.repo_full_name,
      createdAt: r.created_at.toISOString(),
      live: r.live,
      takenDownAt: r.taken_down_at?.toISOString() ?? null,
      takenDownReason: r.taken_down_reason,
      org: {
        id: r.org_id,
        name: r.org_name,
        slug: r.org_slug,
        suspendedAt: r.suspended_at?.toISOString() ?? null,
        suspendedReason: r.suspended_reason,
      },
      owners: r.owners,
    });

    /** The affected account's audit log says what happened and who did it. */
    async function audit(tx: Tx, orgId: string, a: Auth, action: string, id: string, meta: object) {
      await tx`insert into audit_events (org_id, actor_user_id, action, target_type, target_id, metadata)
        values (${orgId}, ${a.userId}, ${action}, ${action.includes('org') ? 'org' : 'project'}, ${id}, ${tx.json(meta as never)})`;
    }

    /** Stops the project's builds and queues the edge update (in the action's transaction). */
    async function stopAndRefresh(tx: Tx, projectId: string, orgId: string) {
      const running = await tx<{ id: string; status: string }[]>`
        select id, status from deployments where project_id = ${projectId}
        and (status = any(${[...IN_PROGRESS]}) or status = 'AWAITING_APPROVAL')`;
      for (const d of running) {
        await requestCancel(tx, { deploymentId: d.id });
        if (['CREATED', 'QUEUED', 'AWAITING_APPROVAL'].includes(d.status))
          await transition(tx, { deploymentId: d.id, to: 'CANCELED', payload: { by: 'admin' } });
      }
      await enqueue(tx, 'routes.refresh', { projectId }, { orgId });
    }

    async function emailOwners(orgId: string, subject: string, text: string) {
      const owners = await deps.sql<{ email: string }[]>`
        select u.email from memberships m join users u on u.id = m.user_id
        where m.org_id = ${orgId} and m.role = 'owner' and u.email is not null`;
      for (const o of owners) await deps.sendEmail({ to: o.email, subject, text }).catch(() => {});
    }
    const footer = `\n\nIf you think this is a mistake, reply to hello@${deps.env.PLATFORM_DOMAIN}.`;

    app.get(
      '/api/v1/admin/sites',
      {
        preHandler: requireAdmin,
        schema: {
          tags: ['admin'],
          querystring: z.object({
            q: z
              .string()
              .max(300)
              .optional()
              .describe('A site address, slug, account or owner login/email'),
            state: z.enum(['down']).optional().describe('down: every site taken down or suspended'),
          }),
          response: { 200: z.array(AdminSite) },
        },
      },
      async (req) => {
        const q = (req.query.q ?? '').trim().toLowerCase();
        const slug = slugFrom(q);
        if (req.query.state !== 'down' && !q) return [];
        const rows = await deps.sql<SiteRow[]>`
          select p.id, p.slug, p.repo_full_name, p.created_at, p.active_deployment_id is not null as live,
                 p.taken_down_at, p.taken_down_reason, o.id as org_id, o.name as org_name, o.slug as org_slug,
                 o.suspended_at, o.suspended_reason,
                 coalesce((select json_agg(json_build_object('login', u.login, 'email', u.email) order by u.login)
                   from memberships m join users u on u.id = m.user_id
                   where m.org_id = o.id and m.role = 'owner'), '[]') as owners
          from projects p join orgs o on o.id = p.org_id
          where ${
            req.query.state === 'down'
              ? deps.sql`(p.taken_down_at is not null or o.suspended_at is not null)`
              : deps.sql`(${slug !== ''} and (p.slug = ${slug} or p.slug like ${`${slug}%`}))
                  or lower(o.slug) = ${q}
                  or exists (select 1 from memberships m join users u on u.id = m.user_id
                             where m.org_id = o.id and (lower(u.login) = ${q} or lower(u.email) = ${q}))`
          }
          order by p.slug = ${slug} desc, p.created_at desc limit 25`;
        return rows.map(toSite);
      },
    );

    app.post(
      '/api/v1/admin/sites/:id/takedown',
      {
        preHandler: [requireAdmin, requireRecentMfa],
        schema: { tags: ['admin'], params: Params, body: AdminReason, response: { 202: Queued } },
      },
      async (req, reply) => {
        const a = authOf(req);
        const p = await deps.sql.begin(async (tx) => {
          const [p] = await tx<{ org_id: string; slug: string }[]>`
            update projects set taken_down_at = now(), taken_down_reason = ${req.body.reason}
            where id = ${req.params.id} returning org_id, slug`;
          if (!p) throw notFound('Site');
          await audit(tx, p.org_id, a, 'admin.site_takedown', req.params.id, {
            slug: p.slug,
            reason: req.body.reason,
          });
          await stopAndRefresh(tx, req.params.id, p.org_id);
          return p;
        });
        await emailOwners(
          p.org_id,
          `Your site ${p.slug}.${domain} was taken down`,
          `AutoDeploy took down ${p.slug}.${domain}: it can't be visited or deployed.\n\nReason: ${req.body.reason}${footer}`,
        );
        return reply.code(202).send({ queued: true as const });
      },
    );

    app.post(
      '/api/v1/admin/sites/:id/restore',
      {
        preHandler: [requireAdmin, requireRecentMfa],
        schema: { tags: ['admin'], params: Params, response: { 202: Queued } },
      },
      async (req, reply) => {
        const a = authOf(req);
        await deps.sql.begin(async (tx) => {
          const [p] = await tx<{ org_id: string; slug: string; suspended: boolean }[]>`
            select p.org_id, p.slug, o.suspended_at is not null as suspended
            from projects p join orgs o on o.id = p.org_id where p.id = ${req.params.id} for update of p`;
          if (!p) throw notFound('Site');
          if (p.suspended)
            throw conflict(
              'account_suspended',
              'The whole account is suspended: lift that instead.',
            );
          await tx`update projects set taken_down_at = null, taken_down_reason = null where id = ${req.params.id}`;
          await audit(tx, p.org_id, a, 'admin.site_restore', req.params.id, { slug: p.slug });
          await enqueue(tx, 'routes.refresh', { projectId: req.params.id }, { orgId: p.org_id });
        });
        return reply.code(202).send({ queued: true as const });
      },
    );

    app.post(
      '/api/v1/admin/orgs/:id/suspend',
      {
        preHandler: [requireAdmin, requireRecentMfa],
        schema: { tags: ['admin'], params: Params, body: AdminReason, response: { 202: Queued } },
      },
      async (req, reply) => {
        const a = authOf(req);
        const name = await deps.sql.begin(async (tx) => {
          const [o] = await tx<{ name: string }[]>`
            update orgs set suspended_at = now(), suspended_reason = ${req.body.reason}
            where id = ${req.params.id} returning name`;
          if (!o) throw notFound('Account');
          await audit(tx, req.params.id, a, 'admin.org_suspend', req.params.id, {
            reason: req.body.reason,
          });
          const projects = await tx<
            { id: string }[]
          >`select id from projects where org_id = ${req.params.id}`;
          for (const p of projects) await stopAndRefresh(tx, p.id, req.params.id);
          return o.name;
        });
        await emailOwners(
          req.params.id,
          `Your AutoDeploy account ${name} was suspended`,
          `AutoDeploy suspended the account ${name}: its sites are offline, and it can't create projects or deploy.\n\nReason: ${req.body.reason}${footer}`,
        );
        return reply.code(202).send({ queued: true as const });
      },
    );

    app.post(
      '/api/v1/admin/orgs/:id/unsuspend',
      {
        preHandler: [requireAdmin, requireRecentMfa],
        schema: { tags: ['admin'], params: Params, response: { 202: Queued } },
      },
      async (req, reply) => {
        const a = authOf(req);
        await deps.sql.begin(async (tx) => {
          const [o] = await tx<{ id: string }[]>`
            update orgs set suspended_at = null, suspended_reason = null where id = ${req.params.id} returning id`;
          if (!o) throw notFound('Account');
          await audit(tx, req.params.id, a, 'admin.org_unsuspend', req.params.id, {});
          // Sites taken down on their own stay down.
          const projects = await tx<
            { id: string }[]
          >`select id from projects where org_id = ${req.params.id}`;
          for (const p of projects)
            await enqueue(tx, 'routes.refresh', { projectId: p.id }, { orgId: req.params.id });
        });
        return reply.code(202).send({ queued: true as const });
      },
    );
  };

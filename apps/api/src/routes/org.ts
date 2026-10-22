import {
  AddMemberBody,
  AnalyticsSummary,
  ApiToken,
  AuditEvent,
  CreatedToken,
  CreatedWebhook,
  CreateTokenBody,
  CreateWebhookBody,
  Invitation,
  Member,
  Page,
  PageQuery,
  PendingInvitation,
  Quota,
  UpdateMemberBody,
  WebhookDelivery,
  WebhookEndpoint,
} from '@autodeploy/contracts';
import { encrypt, randomToken, sha256Hex } from '@autodeploy/crypto';
import { withOrg } from '@autodeploy/db';
import { enqueue } from '@autodeploy/queue';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { authOf, type Role, rankOf, requireRole } from '../plugins/auth.js';
import { usageFor } from '../services/limits.js';

const Params = z.object({ id: z.uuid() });

export const orgRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // ---- members ----
    app.get(
      '/api/v1/members',
      { preHandler: requireRole(), schema: { tags: ['org'], response: { 200: z.array(Member) } } },
      async (req) => {
        const rows = await deps.sql<
          {
            user_id: string;
            login: string;
            name: string | null;
            avatar_url: string | null;
            role: Role;
            created_at: Date;
          }[]
        >`
        select m.user_id, u.login, u.name, u.avatar_url, m.role, m.created_at
        from memberships m join users u on u.id = m.user_id where m.org_id = ${authOf(req).orgId} order by m.created_at`;
        return rows.map((r) => ({
          userId: r.user_id,
          login: r.login,
          name: r.name,
          avatarUrl: r.avatar_url,
          role: r.role,
          joinedAt: r.created_at.toISOString(),
        }));
      },
    );

    // Adding someone invites them: they join only by accepting.
    app.post(
      '/api/v1/members',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'member.invite' },
        schema: {
          tags: ['org'],
          body: AddMemberBody,
          response: { 202: z.object({ invited: z.literal(true) }) },
        },
      },
      async (req, reply) => {
        const a = authOf(req);
        const [user] = await deps.sql<{ id: string; email: string | null }[]>`
          select id, email from users where lower(login) = lower(${req.body.login})`;
        if (!user) throw notFound('User (they must sign in to AutoDeploy once first)');
        const [member] = await deps.sql`
          select 1 from memberships where org_id = ${a.orgId} and user_id = ${user.id}`;
        if (member) throw conflict('already_member', 'They are already a member.');
        await deps.sql`
          insert into invitations (org_id, user_id, role, invited_by)
          values (${a.orgId}, ${user.id}, ${req.body.role}, ${a.userId})
          on conflict (org_id, user_id) do update set role = excluded.role, invited_by = excluded.invited_by`;
        req.auditTarget = { type: 'user', id: user.id, metadata: { role: req.body.role } };
        if (user.email) {
          const [org] = await deps.sql<
            { name: string }[]
          >`select name from orgs where id = ${a.orgId}`;
          await deps
            .sendEmail({
              to: user.email,
              subject: `${a.login} invited you to ${org?.name ?? 'an organisation'} on AutoDeploy`,
              text: `${a.login} invited you to join ${org?.name ?? 'their organisation'} on AutoDeploy as ${req.body.role}.\n\nAccept or decline it here: ${deps.env.APP_URL}/overview\n\nNothing changes until you accept.`,
            })
            .catch((err: unknown) => req.log.warn({ err }, 'invitation email failed'));
        }
        return reply.code(202).send({ invited: true as const });
      },
    );

    app.get(
      '/api/v1/members/invitations',
      {
        preHandler: requireRole('admin'),
        schema: { tags: ['org'], response: { 200: z.array(PendingInvitation) } },
      },
      async (req) => {
        const rows = await deps.sql<{ id: string; login: string; role: Role; created_at: Date }[]>`
          select i.id, u.login, i.role, i.created_at from invitations i join users u on u.id = i.user_id
          where i.org_id = ${authOf(req).orgId} order by i.created_at`;
        return rows.map((r) => ({
          id: r.id,
          login: r.login,
          role: r.role,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.delete(
      '/api/v1/members/invitations/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'member.invite_cancel' },
        schema: { tags: ['org'], params: Params },
      },
      async (req, reply) => {
        const rows = await deps.sql`
          delete from invitations where id = ${req.params.id} and org_id = ${authOf(req).orgId} returning id`;
        if (rows.length === 0) throw notFound('Invitation');
        req.auditTarget = { type: 'invitation', id: req.params.id };
        return reply.code(204).send();
      },
    );

    // The invited person's side: their invitations, accept, decline.
    app.get(
      '/api/v1/invitations',
      {
        preHandler: requireRole(),
        schema: { tags: ['org'], response: { 200: z.array(Invitation) } },
      },
      async (req) => {
        const rows = await deps.sql<
          {
            id: string;
            org_id: string;
            org_name: string;
            org_slug: string;
            role: Role;
            invited_by: string | null;
            created_at: Date;
          }[]
        >`
          select i.id, o.id as org_id, o.name as org_name, o.slug as org_slug, i.role,
            u.login as invited_by, i.created_at
          from invitations i join orgs o on o.id = i.org_id left join users u on u.id = i.invited_by
          where i.user_id = ${authOf(req).userId} order by i.created_at`;
        return rows.map((r) => ({
          id: r.id,
          org: { id: r.org_id, name: r.org_name, slug: r.org_slug },
          role: r.role,
          invitedBy: r.invited_by,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.post(
      '/api/v1/invitations/:id/accept',
      {
        preHandler: requireRole(),
        config: { audit: 'member.join' },
        schema: { tags: ['org'], params: Params, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const a = authOf(req);
        // From a browser session: an API token acts within one org, not across them.
        if (a.via !== 'session') throw forbidden('Accept invitations from a browser session');
        await deps.sql.begin(async (tx) => {
          const [inv] = await tx<{ org_id: string; role: Role }[]>`
            delete from invitations where id = ${req.params.id} and user_id = ${a.userId}
            returning org_id, role`;
          if (!inv) throw notFound('Invitation');
          await tx`insert into memberships (org_id, user_id, role) values (${inv.org_id}, ${a.userId}, ${inv.role})
            on conflict (org_id, user_id) do nothing`;
        });
        req.auditTarget = { type: 'invitation', id: req.params.id };
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/api/v1/invitations/:id/decline',
      {
        preHandler: requireRole(),
        schema: { tags: ['org'], params: Params, response: { 204: z.null() } },
      },
      async (req, reply) => {
        const rows = await deps.sql`
          delete from invitations where id = ${req.params.id} and user_id = ${authOf(req).userId} returning id`;
        if (rows.length === 0) throw notFound('Invitation');
        return reply.code(204).send(null);
      },
    );

    app.patch(
      '/api/v1/members/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'member.role' },
        schema: { tags: ['org'], params: Params, body: UpdateMemberBody },
      },
      async (req, reply) => {
        const a = authOf(req);
        // Only owners can create or demote owners; nobody can raise anyone above themselves.
        if (rankOf(req.body.role) > rankOf(a.role))
          throw forbidden('You cannot grant a role above your own');
        await deps.sql.begin(async (tx) => {
          const [target] = await tx<
            { role: Role }[]
          >`select role from memberships where org_id = ${a.orgId} and user_id = ${req.params.id} for update`;
          if (!target) throw notFound('Member');
          if (target.role === 'owner' && a.role !== 'owner')
            throw forbidden('Only owners can change an owner');
          if (target.role === 'owner' && req.body.role !== 'owner')
            await assertAnotherOwner(tx as never, a.orgId, req.params.id);
          await tx`update memberships set role = ${req.body.role} where org_id = ${a.orgId} and user_id = ${req.params.id}`;
        });
        req.auditTarget = { type: 'user', id: req.params.id, metadata: { role: req.body.role } };
        return reply.code(204).send();
      },
    );

    app.delete(
      '/api/v1/members/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'member.remove' },
        schema: { tags: ['org'], params: Params },
      },
      async (req, reply) => {
        const a = authOf(req);
        await deps.sql.begin(async (tx) => {
          const [target] = await tx<
            { role: Role }[]
          >`select role from memberships where org_id = ${a.orgId} and user_id = ${req.params.id} for update`;
          if (!target) throw notFound('Member');
          if (target.role === 'owner') {
            if (a.role !== 'owner') throw forbidden('Only owners can remove an owner');
            await assertAnotherOwner(tx as never, a.orgId, req.params.id);
          }
          await tx`delete from memberships where org_id = ${a.orgId} and user_id = ${req.params.id}`;
        });
        req.auditTarget = { type: 'user', id: req.params.id };
        return reply.code(204).send();
      },
    );

    // ---- API tokens ----
    app.get(
      '/api/v1/tokens',
      {
        preHandler: requireRole(),
        schema: { tags: ['tokens'], response: { 200: z.array(ApiToken) } },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<
            {
              id: string;
              name: string;
              prefix: string;
              scopes: ('read' | 'deploy' | 'admin')[];
              expires_at: Date | null;
              last_used_at: Date | null;
              created_at: Date;
            }[]
          >`select id, name, prefix, scopes, expires_at, last_used_at, created_at from api_tokens
        where user_id = ${authOf(req).userId} and revoked_at is null order by created_at desc`,
        );
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          prefix: r.prefix,
          scopes: r.scopes,
          expiresAt: r.expires_at?.toISOString() ?? null,
          lastUsedAt: r.last_used_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.post(
      '/api/v1/tokens',
      {
        preHandler: requireRole(),
        config: { audit: 'token.create' },
        schema: { tags: ['tokens'], body: CreateTokenBody, response: { 201: CreatedToken } },
      },
      async (req, reply) => {
        const a = authOf(req);
        if (a.via === 'token') throw forbidden('Create tokens from a browser session');
        if (req.body.scopes.includes('admin') && rankOf(a.role) < rankOf('admin'))
          throw forbidden('Only admins can create admin tokens');
        const token = `adp_${randomToken(30)}`;
        const prefix = token.slice(0, 10);
        const [row] = await withOrg(
          deps.sql,
          a.orgId,
          (tx) => tx<{ id: string; created_at: Date; expires_at: Date | null }[]>`
          insert into api_tokens (org_id, user_id, name, token_hash, prefix, scopes, expires_at)
          values (${a.orgId}, ${a.userId}, ${req.body.name}, ${sha256Hex(token)}, ${prefix}, ${req.body.scopes},
                  ${req.body.expiresInDays ? tx`now() + ${`${req.body.expiresInDays} days`}::interval` : null})
          returning id, created_at, expires_at`,
        );
        if (!row) throw new Error('insert failed');
        req.auditTarget = { type: 'token', id: row.id, metadata: { scopes: req.body.scopes } };
        return reply.code(201).send({
          id: row.id,
          name: req.body.name,
          prefix,
          scopes: req.body.scopes,
          expiresAt: row.expires_at?.toISOString() ?? null,
          lastUsedAt: null,
          createdAt: row.created_at.toISOString(),
          token,
        });
      },
    );

    app.delete(
      '/api/v1/tokens/:id',
      {
        preHandler: requireRole(),
        config: { audit: 'token.revoke' },
        schema: { tags: ['tokens'], params: Params },
      },
      async (req, reply) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx`
          update api_tokens set revoked_at = now() where id = ${req.params.id} and user_id = ${authOf(req).userId} and revoked_at is null returning id`,
        );
        if (rows.length === 0) throw notFound('Token');
        req.auditTarget = { type: 'token', id: req.params.id };
        return reply.code(204).send();
      },
    );

    // ---- outbound webhooks ----
    app.get(
      '/api/v1/webhooks',
      {
        preHandler: requireRole('admin'),
        schema: { tags: ['webhooks'], response: { 200: z.array(WebhookEndpoint) } },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<
            { id: string; url: string; events: string[]; active: boolean; created_at: Date }[]
          >`
        select id, url, events, active, created_at from webhook_endpoints order by created_at`,
        );
        return rows.map((r) => ({
          id: r.id,
          url: r.url,
          events: r.events as never,
          active: r.active,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.post(
      '/api/v1/webhooks',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'webhook.create' },
        schema: { tags: ['webhooks'], body: CreateWebhookBody, response: { 201: CreatedWebhook } },
      },
      async (req, reply) => {
        const a = authOf(req);
        const host = new URL(req.body.url).hostname;
        if (
          deps.env.NODE_ENV === 'production' &&
          /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/.test(host)
        ) {
          throw badRequest('private_address', 'Webhook URLs must be publicly reachable.');
        }
        const secret = `whsec_${randomToken(24)}`;
        const id = crypto.randomUUID();
        const env = encrypt(deps.keyring, secret, `webhook:${id}`);
        const [row] = await withOrg(
          deps.sql,
          a.orgId,
          (tx) => tx<{ created_at: Date }[]>`
          insert into webhook_endpoints (id, org_id, url, secret_ciphertext, secret_dek, key_version, events)
          values (${id}, ${a.orgId}, ${req.body.url}, ${env.ciphertext}, ${env.dekCiphertext}, ${env.keyVersion}, ${req.body.events})
          returning created_at`,
        );
        req.auditTarget = { type: 'webhook', id };
        return reply.code(201).send({
          id,
          url: req.body.url,
          events: req.body.events,
          active: true,
          createdAt: (row?.created_at ?? new Date()).toISOString(),
          secret,
        });
      },
    );

    app.delete(
      '/api/v1/webhooks/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'webhook.delete' },
        schema: { tags: ['webhooks'], params: Params },
      },
      async (req, reply) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx`delete from webhook_endpoints where id = ${req.params.id} returning id`,
        );
        if (rows.length === 0) throw notFound('Webhook');
        req.auditTarget = { type: 'webhook', id: req.params.id };
        return reply.code(204).send();
      },
    );

    app.get(
      '/api/v1/webhooks/:id/deliveries',
      {
        preHandler: requireRole('admin'),
        schema: { tags: ['webhooks'], params: Params, response: { 200: z.array(WebhookDelivery) } },
      },
      async (req) => {
        const rows = await withOrg(deps.sql, authOf(req).orgId, async (tx) => {
          const [ep] = await tx`select 1 from webhook_endpoints where id = ${req.params.id}`;
          if (!ep) throw notFound('Webhook');
          return tx<
            {
              id: string;
              event_type: string;
              status: 'pending' | 'succeeded' | 'failed' | 'dead';
              attempts: number;
              response_status: number | null;
              response_ms: number | null;
              last_error: string | null;
              created_at: Date;
            }[]
          >`select id, event_type, status, attempts, response_status, response_ms, last_error, created_at
          from webhook_deliveries where endpoint_id = ${req.params.id} order by created_at desc limit 50`;
        });
        return rows.map((r) => ({
          id: r.id,
          eventType: r.event_type,
          status: r.status,
          attempts: r.attempts,
          responseStatus: r.response_status,
          responseMs: r.response_ms,
          lastError: r.last_error,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.post(
      '/api/v1/webhooks/:id/deliveries/:deliveryId/redeliver',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'webhook.redeliver' },
        schema: {
          tags: ['webhooks'],
          params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
          response: { 202: z.object({ queued: z.boolean() }) },
        },
      },
      async (req, reply) => {
        await withOrg(deps.sql, authOf(req).orgId, async (tx) => {
          const rows = await tx`update webhook_deliveries set status = 'pending', updated_at = now()
            where id = ${req.params.deliveryId} and endpoint_id = ${req.params.id} returning id`;
          if (rows.length === 0) throw notFound('Delivery');
          await enqueue(
            tx,
            'webhook.deliver',
            { deliveryId: req.params.deliveryId, manual: true },
            { orgId: authOf(req).orgId, maxAttempts: 1 },
          );
        });
        return reply.code(202).send({ queued: true });
      },
    );

    app.post(
      '/api/v1/webhooks/:id/test',
      {
        preHandler: requireRole('admin'),
        schema: {
          tags: ['webhooks'],
          params: Params,
          response: { 202: z.object({ queued: z.boolean() }) },
        },
      },
      async (req, reply) => {
        await withOrg(deps.sql, authOf(req).orgId, async (tx) => {
          const [ep] = await tx`select id from webhook_endpoints where id = ${req.params.id}`;
          if (!ep) throw notFound('Webhook');
          const eventId = `test_${randomToken(10)}`;
          const [d] = await tx<{ id: string }[]>`
            insert into webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload)
            values (${req.params.id}, ${authOf(req).orgId}, ${eventId}, 'ping', ${tx.json({ type: 'ping', id: eventId, sentAt: new Date().toISOString() } as never)})
            returning id`;
          await enqueue(
            tx,
            'webhook.deliver',
            { deliveryId: d?.id },
            { orgId: authOf(req).orgId, maxAttempts: 1 },
          );
        });
        return reply.code(202).send({ queued: true });
      },
    );

    // ---- audit, quota, analytics ----
    app.get(
      '/api/v1/audit',
      {
        preHandler: requireRole('admin'),
        schema: { tags: ['org'], querystring: PageQuery, response: { 200: Page(AuditEvent) } },
      },
      async (req) => {
        const before = req.query.cursor ? Number(req.query.cursor) : null;
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<
            {
              id: number;
              action: string;
              login: string | null;
              target_type: string | null;
              target_id: string | null;
              ip: string | null;
              metadata: Record<string, unknown>;
              created_at: Date;
            }[]
          >`select e.id, e.action, u.login, e.target_type, e.target_id, host(e.ip) as ip, e.metadata, e.created_at
          from audit_events e left join users u on u.id = e.actor_user_id
          where ${before ? tx`e.id < ${before}` : tx`true`} order by e.id desc limit ${req.query.limit + 1}`,
        );
        const more = rows.length > req.query.limit;
        const page = rows.slice(0, req.query.limit);
        return {
          items: page.map((r) => ({
            id: String(r.id),
            action: r.action,
            actor: r.login,
            targetType: r.target_type,
            targetId: r.target_id,
            ip: r.ip,
            metadata: r.metadata,
            createdAt: r.created_at.toISOString(),
          })),
          nextCursor: more ? String(page.at(-1)?.id) : null,
        };
      },
    );

    app.get(
      '/api/v1/quota',
      { preHandler: requireRole(), schema: { tags: ['org'], response: { 200: Quota } } },
      async (req) => {
        const u = await usageFor(deps.sql, authOf(req).orgId, deps.env);
        return { ...u, dailyLimit: u.deploysPerDay };
      },
    );

    app.get(
      '/api/v1/analytics',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['analytics'],
          querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
          response: { 200: AnalyticsSummary },
        },
      },
      async (req) => {
        const days = req.query.days;
        const orgId = authOf(req).orgId;
        return withOrg(deps.sql, orgId, async (tx) => {
          const since = tx`now() - ${`${days} days`}::interval`;
          const [t] = await tx<
            {
              deployments: number;
              succeeded: number;
              failed: number;
              rule: number;
              ai: number;
              escalated: number;
              p50: number | null;
              p95: number | null;
              q50: number | null;
              q95: number | null;
            }[]
          >`
            select count(*)::int as deployments,
              count(*) filter (where outcome = 'succeeded')::int as succeeded,
              count(*) filter (where outcome = 'failed')::int as failed,
              count(*) filter (where recovered_by = 'rule')::int as rule,
              count(*) filter (where recovered_by = 'ai')::int as ai,
              count(*) filter (where outcome in ('failed', 'needs_input') and attempts > 1)::int as escalated,
              percentile_cont(0.5) within group (order by build_ms) as p50,
              percentile_cont(0.95) within group (order by build_ms) as p95,
              percentile_cont(0.5) within group (order by queue_wait_ms) as q50,
              percentile_cont(0.95) within group (order by queue_wait_ms) as q95
            from analytics_builds where finished_at > ${since}`;
          // One row per day in the range, zero-filled, so charts show quiet days too.
          const daily = await tx<
            {
              day: Date;
              deployments: number;
              succeeded: number;
              failed: number;
              p95: number | null;
            }[]
          >`
            select g.day, count(b.deployment_id)::int as deployments,
              count(*) filter (where b.outcome = 'succeeded')::int as succeeded,
              count(*) filter (where b.outcome = 'failed')::int as failed,
              percentile_cont(0.95) within group (order by b.build_ms) as p95
            from generate_series(date_trunc('day', now() - ${`${days - 1} days`}::interval), date_trunc('day', now()), interval '1 day') as g(day)
            left join analytics_builds b on date_trunc('day', b.finished_at) = g.day
            group by g.day order by g.day`;
          const top = await tx<{ code: string; count: number }[]>`
            select error_code as code, count(*)::int as count from deployment_attempts
            where status = 'failed' and error_code is not null and started_at > ${since}
            group by 1 order by 2 desc limit 6`;
          const ai = await tx<
            { provider: string; calls: number; failures: number; avg: number | null }[]
          >`
            select provider, count(*)::int as calls, count(*) filter (where outcome <> 'ok')::int as failures, avg(latency_ms)::float as avg
            from ai_usage where created_at > ${since} group by 1 order by 2 desc`;
          const consumers = await deps.valkey.hgetall('metrics:consumer_lag');
          const dlq = await deps.sql<
            { consumer: string; n: number }[]
          >`select consumer, count(*)::int as n from dead_letters where replayed_at is null group by 1`;
          const groups = new Set([...Object.keys(consumers), ...dlq.map((d) => d.consumer)]);
          const round = (n: number | null | undefined) => (n == null ? null : Math.round(n));
          return {
            days,
            totals: {
              deployments: t?.deployments ?? 0,
              succeeded: t?.succeeded ?? 0,
              failed: t?.failed ?? 0,
              recoveredByRule: t?.rule ?? 0,
              recoveredByAi: t?.ai ?? 0,
              escalated: t?.escalated ?? 0,
            },
            buildMs: { p50: round(t?.p50), p95: round(t?.p95) },
            queueWaitMs: { p50: round(t?.q50), p95: round(t?.q95) },
            daily: daily.map((d) => ({
              day: d.day.toISOString().slice(0, 10),
              deployments: d.deployments,
              succeeded: d.succeeded,
              failed: d.failed,
              p95BuildMs: round(d.p95),
            })),
            topSignatures: top,
            ai: ai.map((r) => ({
              provider: r.provider,
              calls: r.calls,
              failures: r.failures,
              avgLatencyMs: round(r.avg),
            })),
            consumers: [...groups].map((g) => ({
              group: g,
              lag: consumers[g] !== undefined ? Number(consumers[g]) : null,
              dlq: dlq.find((d) => d.consumer === g)?.n ?? 0,
            })),
          };
        });
      },
    );
  };

async function assertAnotherOwner(tx: Deps['sql'], orgId: string, exceptUserId: string) {
  const [o] = await tx<
    { n: number }[]
  >`select count(*)::int as n from memberships where org_id = ${orgId} and role = 'owner' and user_id <> ${exceptUserId}`;
  if (!o || o.n === 0) throw conflict('last_owner', 'An org must keep at least one owner.');
}

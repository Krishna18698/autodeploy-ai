import {
  CreateDeploymentBody,
  Deployment,
  DeploymentEvent,
  DeploymentSummary,
  LogPage,
  Page,
  PageQuery,
  Repair,
  RollbackBody,
} from '@autodeploy/contracts';
import { IN_PROGRESS } from '@autodeploy/core';
import { activate, PostgresRouteStore, transition, withOrg } from '@autodeploy/db';
import { enqueue, requestCancel } from '@autodeploy/queue';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError, conflict, notFound, unavailable } from '../lib/errors.js';
import { authOf, requireRole } from '../plugins/auth.js';
import { createDeployment } from '../services/deployments.js';
import {
  type AttemptRow,
  type DeploymentRow,
  decodeCursor,
  encodeCursor,
  type RepairRow,
  toDeployment,
  toRepair,
} from '../services/mappers.js';
import { resolveSource } from '../services/sources.js';
import { streamDeployment } from '../services/stream.js';

const Params = z.object({ id: z.uuid() });

export const deploymentRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { PLATFORM_DOMAIN: domain, API_PUBLIC_URL: apiUrl } = deps.env;
    const routes = new PostgresRouteStore();

    async function load(orgId: string, id: string) {
      return withOrg(deps.sql, orgId, async (tx) => {
        const [d] = await tx<DeploymentRow[]>`
          select d.*, p.slug as project_slug from deployments d join projects p on p.id = d.project_id where d.id = ${id}`;
        if (!d) throw notFound('Deployment');
        const attempts = await tx<AttemptRow[]>`
          select id, attempt_no, executor, status, build_config, error_code, error_signature, started_at, finished_at
          from deployment_attempts where deployment_id = ${id} order by attempt_no`;
        return toDeployment(d, attempts, domain, apiUrl);
      });
    }

    app.post(
      '/api/v1/projects/:id/deployments',
      {
        preHandler: requireRole('member'),
        config: {
          audit: 'deployment.create',
          idempotent: true,
          rateLimit: { limit: 30, windowMs: 60_000 },
        },
        schema: {
          tags: ['deployments'],
          params: Params,
          body: CreateDeploymentBody,
          response: { 201: Deployment },
        },
      },
      async (req, reply) => {
        const a = authOf(req);
        const [project] = await withOrg(
          deps.sql,
          a.orgId,
          (tx) => tx<{ id: string; repo_url: string; default_branch: string }[]>`
          select id, repo_url, default_branch from projects where id = ${req.params.id}`,
        );
        if (!project) throw notFound('Project');
        const src = await resolveSource(
          deps,
          project.repo_url,
          req.body.ref ?? project.default_branch,
        );
        const d = await createDeployment(deps, {
          orgId: a.orgId,
          projectId: project.id,
          kind: req.body.kind,
          trigger: a.via === 'token' ? 'cli' : 'manual',
          ref: src.ref,
          commitSha: src.commitSha,
          commitMessage: src.commitMessage,
          branch: src.branch,
          createdBy: a.userId,
          idempotencyKey:
            typeof req.headers['idempotency-key'] === 'string'
              ? req.headers['idempotency-key']
              : null,
        });
        req.auditTarget = { type: 'deployment', id: d.id, metadata: { number: d.number } };
        return reply.code(201).send(await load(a.orgId, d.id));
      },
    );

    app.get(
      '/api/v1/deployments',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['deployments'],
          querystring: PageQuery.extend({
            projectId: z.uuid().optional(),
            status: z.enum(['active', 'failed', 'in_progress', 'awaiting_approval']).optional(),
            kind: z.enum(['production', 'preview']).optional(),
          }),
          response: { 200: Page(DeploymentSummary) },
        },
      },
      async (req) => {
        const q = req.query;
        const c = decodeCursor(q.cursor);
        const statusFilter = {
          active: ['ACTIVE'],
          failed: ['FAILED', 'NEEDS_INPUT'],
          in_progress: [...IN_PROGRESS],
          awaiting_approval: ['AWAITING_APPROVAL'],
        }[q.status ?? 'active'];
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<DeploymentRow[]>`
          select d.*, p.slug as project_slug,
            (select count(*)::int from deployment_attempts a where a.deployment_id = d.id) as attempt_count
          from deployments d join projects p on p.id = d.project_id
          where true
            ${q.projectId ? tx`and d.project_id = ${q.projectId}` : tx``}
            ${q.status ? tx`and d.status = any(${statusFilter as string[]})` : tx``}
            ${q.kind ? tx`and d.kind = ${q.kind}` : tx``}
            ${c ? tx`and (d.created_at, d.id) < (${c.createdAt}, ${c.id})` : tx``}
          order by d.created_at desc, d.id desc limit ${q.limit + 1}`,
        );
        const more = rows.length > q.limit;
        const page = rows.slice(0, q.limit);
        const last = page.at(-1);
        return {
          items: page.map((r) => ({
            ...omitAttempts(toDeployment(r, [], domain, apiUrl)),
            attemptCount: r.attempt_count ?? 0,
          })),
          nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null,
        };
      },
    );

    app.get(
      '/api/v1/deployments/:id',
      {
        preHandler: requireRole(),
        schema: { tags: ['deployments'], params: Params, response: { 200: Deployment } },
      },
      async (req) => load(authOf(req).orgId, req.params.id),
    );

    app.post(
      '/api/v1/deployments/:id/cancel',
      {
        preHandler: requireRole('member'),
        config: { audit: 'deployment.cancel' },
        schema: { tags: ['deployments'], params: Params, response: { 200: Deployment } },
      },
      async (req) => {
        const a = authOf(req);
        await withOrg(deps.sql, a.orgId, async (tx) => {
          const [d] = await tx<
            { status: string }[]
          >`select status from deployments where id = ${req.params.id} for update`;
          if (!d) throw notFound('Deployment');
          if (!IN_PROGRESS.has(d.status as never) && d.status !== 'AWAITING_APPROVAL') {
            throw conflict('not_cancelable', `A ${d.status} deployment can't be canceled.`);
          }
          // Queued jobs stop now; a running build sees the flag on its next heartbeat.
          await requestCancel(tx, { deploymentId: req.params.id });
          if (d.status === 'CREATED' || d.status === 'QUEUED' || d.status === 'AWAITING_APPROVAL') {
            await transition(tx, {
              deploymentId: req.params.id,
              to: 'CANCELED',
              payload: { by: a.login },
            });
          }
        });
        req.auditTarget = { type: 'deployment', id: req.params.id };
        return load(a.orgId, req.params.id);
      },
    );

    app.get(
      '/api/v1/deployments/:id/events',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['deployments'],
          params: Params,
          response: { 200: z.array(DeploymentEvent) },
        },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) =>
            tx<
              {
                id: number;
                type: string;
                from_status: string | null;
                to_status: string | null;
                payload: Record<string, unknown>;
                created_at: Date;
              }[]
            >`select id, type, from_status, to_status, payload, created_at from deployment_events where deployment_id = ${req.params.id} order by id`,
        );
        return rows.map((r) => ({
          id: String(r.id),
          type: r.type,
          fromStatus: r.from_status as never,
          toStatus: r.to_status as never,
          payload: r.payload,
          createdAt: r.created_at.toISOString(),
        }));
      },
    );

    app.get(
      '/api/v1/deployments/:id/logs',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['deployments'],
          params: Params,
          querystring: z.object({
            attempt: z.coerce.number().int().min(1).optional(),
            cursor: z.coerce.number().int().min(0).default(0),
          }),
          response: { 200: LogPage },
        },
      },
      async (req) => {
        const chunks = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<
            {
              attempt_no: number;
              seq: number;
              first_line: number;
              line_count: number;
              storage_key: string;
              status: string;
            }[]
          >`
          select a.attempt_no, c.seq, c.first_line, c.line_count, c.storage_key, a.status
          from deployment_attempts a join build_log_chunks c on c.attempt_id = a.id
          where a.deployment_id = ${req.params.id} ${req.query.attempt ? tx`and a.attempt_no = ${req.query.attempt}` : tx``}
          order by a.attempt_no, c.seq`,
        );
        // Cursor = global line index across the selected attempts; serve up to ~2000 lines per page.
        const lines: Array<{ seq: number; attemptNo: number; text: string }> = [];
        let index = 0;
        let next: number | null = null;
        for (const ch of chunks) {
          if (index + ch.line_count <= req.query.cursor) {
            index += ch.line_count;
            continue;
          }
          if (lines.length >= 2000) {
            next = index;
            break;
          }
          const text = (await deps.storage.getText(ch.storage_key)) ?? '';
          for (const [i, t] of text.split('\n').slice(0, ch.line_count).entries()) {
            if (index >= req.query.cursor)
              lines.push({ seq: ch.first_line + i, attemptNo: ch.attempt_no, text: t });
            index++;
          }
        }
        const running = chunks.some((c) => c.status === 'running');
        return {
          lines,
          nextCursor: next !== null ? String(next) : null,
          complete: !running && next === null,
        };
      },
    );

    // Server-Sent Events: snapshot, then live status + log lines. Resumable with Last-Event-ID.
    app.get(
      '/api/v1/deployments/:id/stream',
      {
        preHandler: requireRole(),
        config: { rateLimit: { limit: 60, windowMs: 60_000 } },
        schema: { tags: ['deployments'], params: Params, hide: true },
      },
      async (req, reply) => {
        const snapshot = await load(authOf(req).orgId, req.params.id);
        const lastId =
          typeof req.headers['last-event-id'] === 'string'
            ? req.headers['last-event-id']
            : undefined;
        await streamDeployment(deps, req, reply, snapshot, lastId);
      },
    );

    app.get(
      '/api/v1/deployments/:id/screenshot',
      { preHandler: requireRole(), schema: { tags: ['deployments'], params: Params, hide: true } },
      async (req, reply) => {
        const [d] = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<{ screenshot_key: string | null }[]>`
          select screenshot_key from deployments where id = ${req.params.id}`,
        );
        if (!d?.screenshot_key) throw notFound('Screenshot');
        const obj = await deps.storage.getStream(d.screenshot_key);
        if (!obj) throw notFound('Screenshot');
        reply.header('cache-control', 'private, max-age=31536000, immutable');
        return reply.type('image/png').send(obj.body);
      },
    );

    app.post(
      '/api/v1/projects/:id/rollback',
      {
        preHandler: requireRole('member'),
        config: { audit: 'deployment.rollback' },
        schema: {
          tags: ['deployments'],
          params: Params,
          body: RollbackBody,
          response: {
            200: z.object({
              activatedId: z.uuid(),
              previousId: z.uuid().nullable(),
              ms: z.number(),
            }),
          },
        },
      },
      async (req) => {
        const a = authOf(req);
        const [target] = await withOrg(
          deps.sql,
          a.orgId,
          (tx) => tx<{ id: string; status: string; kind: string }[]>`
          select id, status, kind from deployments where id = ${req.body.deploymentId} and project_id = ${req.params.id}`,
        );
        if (!target) throw notFound('Deployment');
        if (target.kind !== 'production')
          throw conflict('not_production', 'Only production deployments can be rolled back to.');
        if (!['SUPERSEDED', 'ROLLED_BACK'].includes(target.status)) {
          throw conflict(
            'not_rollback_target',
            `Can only roll back to a previously live deployment (this one is ${target.status}).`,
          );
        }
        const result = await activate(deps.sql, routes, target.id, 'rollback', a.login);
        req.auditTarget = {
          type: 'deployment',
          id: target.id,
          metadata: { ms: Math.round(result.ms) },
        };
        return result;
      },
    );

    // ---- repairs ----
    app.get(
      '/api/v1/deployments/:id/repairs',
      {
        preHandler: requireRole(),
        schema: { tags: ['repairs'], params: Params, response: { 200: z.array(Repair) } },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<RepairRow[]>`
          select * from repair_attempts where deployment_id = ${req.params.id} order by created_at`,
        );
        return rows.map(toRepair);
      },
    );

    app.get(
      '/api/v1/repairs',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['repairs'],
          querystring: z.object({
            status: z.enum(['awaiting_approval', 'all']).default('all'),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          }),
          response: {
            200: z.array(Repair.extend({ projectSlug: z.string(), deploymentNumber: z.number() })),
          },
        },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<(RepairRow & { project_slug: string; number: number })[]>`
          select r.*, p.slug as project_slug, d.number from repair_attempts r
          join deployments d on d.id = r.deployment_id join projects p on p.id = d.project_id
          where ${req.query.status === 'awaiting_approval' ? tx`r.status = 'awaiting_approval'` : tx`true`}
          order by r.created_at desc limit ${req.query.limit}`,
        );
        return rows.map((r) => ({
          ...toRepair(r),
          projectSlug: r.project_slug,
          deploymentNumber: r.number,
        }));
      },
    );

    app.post(
      '/api/v1/repairs/:id/approve',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'repair.approve' },
        schema: { tags: ['repairs'], params: Params, response: { 200: Repair } },
      },
      async (req) => {
        const a = authOf(req);
        const repair = await withOrg(deps.sql, a.orgId, async (tx) => {
          const [r] = await tx<
            RepairRow[]
          >`select * from repair_attempts where id = ${req.params.id} for update`;
          if (!r) throw notFound('Repair');
          if (r.status !== 'awaiting_approval')
            throw conflict('not_awaiting_approval', `This repair is ${r.status}.`);
          const [updated] = await tx<
            RepairRow[]
          >`update repair_attempts set status = 'approved', decided_by = ${a.userId}, decided_at = now()
            where id = ${r.id} returning *`;
          // The patched build was already validated; approval publishes it as-is.
          const dep = await transition(tx, {
            deploymentId: r.deployment_id,
            to: 'READY',
            payload: {
              approvedBy: a.login,
              repairId: r.id,
              recoveredBy: 'ai',
              attempts:
                (
                  await tx<
                    { n: number }[]
                  >`select count(*)::int as n from deployment_attempts where deployment_id = ${r.deployment_id}`
                )[0]?.n ?? 1,
              buildMs:
                (
                  await tx<
                    { ms: number | null }[]
                  >`select sum(duration_ms)::int as ms from deployment_attempts where deployment_id = ${r.deployment_id}`
                )[0]?.ms ?? null,
            },
            expectFrom: ['AWAITING_APPROVAL'],
            set: { recovered_by: 'ai' },
          });
          if (dep.kind === 'production') {
            await enqueue(
              tx,
              'deployment.activate',
              { deploymentId: dep.id },
              { orgId: a.orgId, idempotencyKey: `activate:${dep.id}` },
            );
          }
          return updated;
        });
        req.auditTarget = { type: 'repair', id: req.params.id };
        if (!repair) throw notFound('Repair');
        return toRepair(repair);
      },
    );

    app.post(
      '/api/v1/repairs/:id/reject',
      {
        preHandler: requireRole('member'),
        config: { audit: 'repair.reject' },
        schema: { tags: ['repairs'], params: Params, response: { 200: Repair } },
      },
      async (req) => {
        const a = authOf(req);
        const repair = await withOrg(deps.sql, a.orgId, async (tx) => {
          const [r] = await tx<
            RepairRow[]
          >`select * from repair_attempts where id = ${req.params.id} for update`;
          if (!r) throw notFound('Repair');
          if (r.status !== 'awaiting_approval')
            throw conflict('not_awaiting_approval', `This repair is ${r.status}.`);
          const [updated] = await tx<
            RepairRow[]
          >`update repair_attempts set status = 'rejected', decided_by = ${a.userId}, decided_at = now()
            where id = ${r.id} returning *`;
          await transition(tx, {
            deploymentId: r.deployment_id,
            to: 'FAILED',
            payload: { rejectedBy: a.login, repairId: r.id },
            expectFrom: ['AWAITING_APPROVAL'],
            set: { error_summary: 'Proposed repair was rejected.' },
          });
          return updated;
        });
        req.auditTarget = { type: 'repair', id: req.params.id };
        if (!repair) throw notFound('Repair');
        return toRepair(repair);
      },
    );

    app.post(
      '/api/v1/repairs/:id/pull-request',
      {
        preHandler: requireRole('member'),
        config: { audit: 'repair.open_pr' },
        schema: {
          tags: ['repairs'],
          params: Params,
          response: { 202: z.object({ queued: z.boolean() }) },
        },
      },
      async (req, reply) => {
        if (!deps.installations)
          throw unavailable(
            'github_not_configured',
            'Opening pull requests needs the GitHub App to be configured.',
          );
        const a = authOf(req);
        await withOrg(deps.sql, a.orgId, async (tx) => {
          const [r] = await tx<
            { diff: string | null; pr_url: string | null }[]
          >`select diff, pr_url from repair_attempts where id = ${req.params.id}`;
          if (!r) throw notFound('Repair');
          if (!r.diff)
            throw new AppError(
              409,
              'no_patch',
              'Only AI source patches can be opened as pull requests.',
            );
          if (r.pr_url) throw conflict('pr_exists', `A pull request already exists: ${r.pr_url}`);
          await enqueue(
            tx,
            'repair.open_pr',
            { repairId: req.params.id, requestedBy: a.login },
            { orgId: a.orgId, idempotencyKey: `pr:${req.params.id}` },
          );
        });
        req.auditTarget = { type: 'repair', id: req.params.id };
        return reply.code(202).send({ queued: true });
      },
    );
  };

function omitAttempts<T extends { attempts: unknown }>(d: T): Omit<T, 'attempts'> {
  const { attempts: _a, ...rest } = d;
  return rest;
}

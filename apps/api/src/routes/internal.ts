import { parseSiteHost } from '@autodeploy/core';
import { safeEqual } from '@autodeploy/crypto';
import { TAKEN_DOWN } from '@autodeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { sitesDomain } from '../env.js';
import { forbidden, notFound } from '../lib/errors.js';

// Origin-side route resolution for the edge Worker: always in local
// development; in production when Cloudflare KV fails (its free plan allows
// 100,000 reads a day; on 2026-10-24 a load test used them up and every site
// answered 500). So it answers as KV would, takedowns included.

export const internalRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/internal/routes/:host',
      {
        config: { rateLimit: false },
        schema: {
          hide: true,
          params: z.object({ host: z.string().max(253) }),
          response: {
            200: z.union([
              z.object({
                deploymentId: z.uuid(),
                number: z.number(),
                artifactSha: z.string(),
                projectSlug: z.string(),
                mode: z.literal('ssr').optional(),
              }),
              z.object({ takenDown: z.literal(true) }),
            ]),
          },
        },
      },
      async (req, reply) => {
        const token = req.headers['x-internal-token'];
        if (typeof token !== 'string' || !safeEqual(token, deps.env.INTERNAL_TOKEN))
          throw forbidden();
        const route = parseSiteHost(req.params.host, sitesDomain(deps.env));
        if (!route) throw notFound('Site');
        reply.header('cache-control', 'no-store');
        // A project taken down, or its account suspended: every address answers 451.
        const [down] = await deps.sql<{ down: boolean }[]>`
          select p.taken_down_at is not null or o.suspended_at is not null as down
          from projects p join orgs o on o.id = p.org_id where p.slug = ${route.slug}`;
        if (down?.down) return TAKEN_DOWN;
        const rows =
          route.kind === 'production'
            ? await deps.sql<
                { id: string; number: number; sha256: string; mode: 'static' | 'ssr' }[]
              >`
                select d.id, d.number, a.sha256, d.mode from projects p
                join deployments d on d.id = p.active_deployment_id join artifacts a on a.id = d.artifact_id
                where p.slug = ${route.slug}`
            : route.kind === 'preview'
              ? await deps.sql<
                  { id: string; number: number; sha256: string; mode: 'static' | 'ssr' }[]
                >`
                  select d.id, d.number, a.sha256, d.mode from projects p
                  join deployments d on d.project_id = p.id join artifacts a on a.id = d.artifact_id
                  where p.slug = ${route.slug} and d.kind = 'preview' and d.pr_number = ${route.pr}
                    and d.status in ('READY', 'AWAITING_APPROVAL')
                  order by d.number desc limit 1`
              : await deps.sql<
                  { id: string; number: number; sha256: string; mode: 'static' | 'ssr' }[]
                >`
                  select d.id, d.number, a.sha256, d.mode from projects p
                  join deployments d on d.project_id = p.id join artifacts a on a.id = d.artifact_id
                  where p.slug = ${route.slug} and d.number = ${route.number}`;
        const r = rows[0];
        if (!r) throw notFound('Site');
        return {
          deploymentId: r.id,
          number: r.number,
          artifactSha: r.sha256,
          projectSlug: route.slug,
          ...(r.mode === 'ssr' && { mode: 'ssr' as const }),
        };
      },
    );
  };

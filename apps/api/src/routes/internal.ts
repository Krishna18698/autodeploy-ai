import { parseSiteHost } from '@autodeploy/core';
import { safeEqual } from '@autodeploy/crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { forbidden, notFound } from '../lib/errors.js';

// Origin-side route resolution for the edge Worker in local development (in
// production the Worker reads Cloudflare KV and never calls the origin).

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
            200: z.object({
              deploymentId: z.uuid(),
              number: z.number(),
              artifactSha: z.string(),
              projectSlug: z.string(),
              mode: z.literal('ssr').optional(),
            }),
          },
        },
      },
      async (req, reply) => {
        const token = req.headers['x-internal-token'];
        if (typeof token !== 'string' || !safeEqual(token, deps.env.INTERNAL_TOKEN))
          throw forbidden();
        const route = parseSiteHost(req.params.host, deps.env.PLATFORM_DOMAIN);
        if (!route) throw notFound('Site');

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
        reply.header('cache-control', 'no-store');
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

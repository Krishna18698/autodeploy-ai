import {
  AnalyzeBody,
  AnalyzeResult,
  CreateProjectBody,
  EnvVar,
  EnvVarKey,
  GitHubRepos,
  ImportEnvBody,
  Page,
  PageQuery,
  Project,
  PutEnvVarBody,
  SlugAvailability,
  UpdateProjectBody,
} from '@autodeploy/contracts';
import { isValidSlug, RESERVED_LABELS } from '@autodeploy/core';
import { encrypt, previewSecret } from '@autodeploy/crypto';
import { withOrg } from '@autodeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { authOf, requireRole } from '../plugins/auth.js';
import { createDeployment } from '../services/deployments.js';
import { enforceProjectLimit } from '../services/limits.js';
import { decodeCursor, encodeCursor, type ProjectRow, toProject } from '../services/mappers.js';
import { queueSiteRemoval } from '../services/site-removal.js';
import { analyzeSource, resolveSource, suggestSlug } from '../services/sources.js';

export const projectRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const domain = deps.env.PLATFORM_DOMAIN;
    const heavy = { rateLimit: { limit: 20, windowMs: 60_000 } };

    // The repo picker: repositories the GitHub App can see *for this user* —
    // installations on their own account or claimed by their org, never
    // another tenant's (same rule as resolving a source).
    app.get(
      '/api/v1/github/repos',
      {
        preHandler: requireRole('member'),
        config: heavy,
        schema: { tags: ['projects'], response: { 200: GitHubRepos } },
      },
      async (req) => {
        const a = authOf(req);
        const slug = deps.env.GITHUB_APP_SLUG;
        const installUrl = slug ? `https://github.com/apps/${slug}/installations/new` : null;
        if (!deps.installations) return { configured: false, installUrl, accounts: [], repos: [] };
        const claimed = await deps.sql<{ id: string }[]>`
          select id from github_installations where org_id = ${a.orgId}`;
        const mine = (await deps.installations.list()).filter(
          (i) =>
            i.account.toLowerCase() === a.login.toLowerCase() ||
            claimed.some((c) => Number(c.id) === i.id),
        );
        const repos = (
          await Promise.all(mine.map((i) => deps.installations?.repositories(i.id) ?? []))
        ).flat();
        // Imported at the repo root: the picker links to it. Projects in a
        // subdirectory leave the repo pickable, for a monorepo's other apps.
        const imported = new Map(
          (
            await withOrg(
              deps.sql,
              a.orgId,
              (tx) =>
                tx<
                  { id: string; repo_full_name: string }[]
                >`select id, repo_full_name from projects where root_dir in ('.', '')`,
            )
          ).map((p) => [p.repo_full_name.toLowerCase(), p.id]),
        );
        return {
          configured: true,
          installUrl,
          accounts: mine.map((i) => i.account),
          repos: repos
            .map((r) => {
              const projectId = imported.get(r.fullName.toLowerCase()) ?? null;
              return { ...r, imported: projectId !== null, projectId };
            })
            .sort((x, y) => (y.pushedAt ?? '').localeCompare(x.pushedAt ?? '')),
        };
      },
    );

    app.post(
      '/api/v1/analyze',
      {
        preHandler: requireRole('member'),
        config: heavy,
        schema: { tags: ['projects'], body: AnalyzeBody, response: { 200: AnalyzeResult } },
      },
      async (req) => {
        const a = authOf(req);
        const src = await resolveSource(deps, req.body.repoUrl, req.body.ref, a);
        const analysis = await analyzeSource(deps, src, req.body.rootDir);
        return {
          repo: { fullName: src.fullName, ref: src.ref, commitSha: src.commitSha },
          analysis,
          suggestedSlug: await firstFreeSlug(deps, suggestSlug(src.fullName)),
        };
      },
    );

    app.get(
      '/api/v1/slugs/:slug',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['projects'],
          params: z.object({ slug: z.string() }),
          response: { 200: SlugAvailability },
        },
      },
      async (req) => {
        const slug = req.params.slug.toLowerCase();
        const domain = deps.env.PLATFORM_DOMAIN;
        if (RESERVED_LABELS.has(slug))
          return { slug, domain, available: false, reason: 'reserved' };
        if (!isValidSlug(slug))
          return {
            slug,
            domain,
            available: false,
            reason: 'use 1–40 lowercase letters, digits and single hyphens',
          };
        const [taken] = await deps.sql`select 1 from projects where slug = ${slug}`;
        return taken
          ? { slug, domain, available: false, reason: 'taken' }
          : { slug, domain, available: true };
      },
    );

    app.post(
      '/api/v1/projects',
      {
        preHandler: requireRole('member'),
        config: { ...heavy, audit: 'project.create', idempotent: true },
        schema: {
          tags: ['projects'],
          body: CreateProjectBody,
          response: { 201: z.object({ project: Project, deploymentId: z.uuid().nullable() }) },
        },
      },
      async (req, reply) => {
        const a = authOf(req);
        const src = await resolveSource(deps, req.body.repoUrl, undefined, a);
        const analysis = await analyzeSource(deps, src, req.body.rootDir);
        const slug = (
          req.body.slug ?? (await firstFreeSlug(deps, suggestSlug(src.fullName)))
        ).toLowerCase();
        if (!isValidSlug(slug))
          throw badRequest(
            'invalid_slug',
            'Slugs are 1–40 lowercase letters, digits and single hyphens.',
          );

        if (analysis.mode.value === 'ssr') {
          const [{ n } = { n: 0 }] = await withOrg(
            deps.sql,
            a.orgId,
            (tx) => tx<{ n: number }[]>`
              select count(*)::int as n from projects where analysis->'mode'->>'value' = 'ssr'`,
          );
          if (n >= deps.env.SSR_PROJECTS_PER_ORG)
            throw conflict(
              'ssr_quota',
              `This org already has ${n} server-rendered projects (the limit is ${deps.env.SSR_PROJECTS_PER_ORG}).`,
            );
        }
        // Remember (and claim for this org) the App installation that gives
        // access; builds, commit statuses and fix PRs all use it.
        if (src.installationId)
          await deps.sql`
            insert into github_installations (id, account_login, org_id)
            values (${src.installationId}, ${src.installationAccount ?? src.repo.owner}, ${a.orgId})
            on conflict (id) do update set org_id = coalesce(github_installations.org_id, excluded.org_id)`;
        const project = await withOrg(deps.sql, a.orgId, async (tx) => {
          await enforceProjectLimit(tx, a.orgId, deps.env);
          const [row] = await tx<ProjectRow[]>`
            insert into projects (org_id, slug, name, repo_full_name, repo_url, default_branch, framework, root_dir, analysis, installation_id)
            values (${a.orgId}, ${slug}, ${req.body.name ?? src.fullName.split('/')[1] ?? slug}, ${src.fullName}, ${src.repoUrl},
                    ${src.defaultBranch}, ${analysis.framework.value}, ${req.body.rootDir}, ${tx.json(analysis as never)}, ${src.installationId})
            returning *`;
          return row;
        }).catch((err: { code?: string; constraint_name?: string }) => {
          if (err.code === '23505' && err.constraint_name === 'projects_slug_key')
            throw conflict('slug_taken', `"${slug}" is already taken.`);
          if (err.code === '23505')
            throw conflict(
              'project_exists',
              'This repository (and root directory) is already a project.',
            );
          throw err;
        });
        if (!project) throw new Error('insert failed');
        req.auditTarget = { type: 'project', id: project.id, metadata: { repo: src.fullName } };

        let deploymentId: string | null = null;
        if (req.body.deploy && analysis.supported) {
          const d = await createDeployment(deps, {
            orgId: a.orgId,
            projectId: project.id,
            kind: 'production',
            trigger: 'manual',
            ref: src.ref,
            commitSha: src.commitSha,
            commitMessage: src.commitMessage,
            branch: src.branch,
            createdBy: a.userId,
          });
          deploymentId = d.id;
        }
        return reply.code(201).send({ project: toProject(project, domain), deploymentId });
      },
    );

    app.get(
      '/api/v1/projects',
      {
        preHandler: requireRole(),
        schema: { tags: ['projects'], querystring: PageQuery, response: { 200: Page(Project) } },
      },
      async (req) => {
        const c = decodeCursor(req.query.cursor);
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<ProjectRow[]>`
          select p.*, l.id as latest_id, l.number as latest_number, l.status as latest_status, l.created_at as latest_created_at
          from projects p
          left join lateral (select id, number, status, created_at from deployments d where d.project_id = p.id order by created_at desc limit 1) l on true
          where ${c ? tx`(p.created_at, p.id) < (${c.createdAt}, ${c.id})` : tx`true`}
          order by p.created_at desc, p.id desc limit ${req.query.limit + 1}`,
        );
        const more = rows.length > req.query.limit;
        const page = rows.slice(0, req.query.limit);
        const last = page.at(-1);
        return {
          items: page.map((r) => toProject(r, domain)),
          nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null,
        };
      },
    );

    app.get(
      '/api/v1/projects/:id',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['projects'],
          params: z.object({ id: z.uuid() }),
          response: { 200: Project },
        },
      },
      async (req, reply) => {
        const [row] = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<ProjectRow[]>`
          select p.*, l.id as latest_id, l.number as latest_number, l.status as latest_status, l.created_at as latest_created_at from projects p
          left join lateral (select id, number, status, created_at from deployments d where d.project_id = p.id order by created_at desc limit 1) l on true
          where p.id = ${req.params.id}`,
        );
        if (!row) throw notFound('Project');
        reply.header('ETag', `"v${row.version}"`);
        return toProject(row, domain);
      },
    );

    app.patch(
      '/api/v1/projects/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'project.update' },
        schema: {
          tags: ['projects'],
          params: z.object({ id: z.uuid() }),
          body: UpdateProjectBody,
          response: { 200: Project },
        },
      },
      async (req, reply) => {
        // Optimistic concurrency: If-Match: "v<version>" must match the stored version.
        const ifMatch = req.headers['if-match'];
        const expected =
          typeof ifMatch === 'string' ? Number(/^"?v(\d+)"?$/.exec(ifMatch)?.[1]) : undefined;
        const b = req.body;
        const set: Record<string, unknown> = {};
        if (b.name !== undefined) set.name = b.name;
        if (b.defaultBranch !== undefined) set.default_branch = b.defaultBranch;
        if (b.executor !== undefined) set.executor = b.executor;
        if (b.nodeVersion !== undefined) set.node_version = b.nodeVersion;
        if (b.installCommand !== undefined) set.install_command = b.installCommand;
        if (b.buildCommand !== undefined) set.build_command = b.buildCommand;
        if (b.outputDir !== undefined) set.output_dir = b.outputDir;
        if (b.rootDir !== undefined) set.root_dir = b.rootDir;
        if (b.aiRepair !== undefined) set.ai_repair = b.aiRepair;
        if (b.nodeVersion != null && ![18, 20, 22, 24].includes(b.nodeVersion)) {
          throw badRequest('unsupported_node', 'Supported Node versions: 18, 20, 22, 24.');
        }
        const row = await withOrg(deps.sql, authOf(req).orgId, async (tx) => {
          const [cur] = await tx<
            { version: number }[]
          >`select version from projects where id = ${req.params.id} for update`;
          if (!cur) throw notFound('Project');
          if (expected !== undefined && !Number.isNaN(expected) && expected !== cur.version) {
            throw new AppError(
              412,
              'version_mismatch',
              `Project changed since you loaded it (now v${cur.version}). Reload and retry.`,
            );
          }
          const [r] = await tx<ProjectRow[]>`
            update projects set ${tx({ ...set, updated_at: new Date() })}, version = version + 1
            where id = ${req.params.id} returning *`;
          return r;
        });
        if (!row) throw notFound('Project');
        req.auditTarget = { type: 'project', id: row.id, metadata: { fields: Object.keys(set) } };
        reply.header('ETag', `"v${row.version}"`);
        return toProject(row, domain);
      },
    );

    app.delete(
      '/api/v1/projects/:id',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'project.delete' },
        schema: { tags: ['projects'], params: z.object({ id: z.uuid() }) },
      },
      async (req, reply) => {
        const orgId = authOf(req).orgId;
        const deleted = await withOrg(deps.sql, orgId, async (tx) => {
          await tx`select set_config('app.allow_event_delete', 'on', true)`;
          // The edge keeps serving whatever KV points at: take the project's
          // hostnames off it too, in this transaction.
          await queueSiteRemoval(tx, req.params.id, orgId);
          return tx`delete from projects where id = ${req.params.id} returning id`;
        });
        if (deleted.length === 0) throw notFound('Project');
        req.auditTarget = { type: 'project', id: req.params.id };
        return reply.code(204).send();
      },
    );

    // ---- environment variables (values are write-only) ----
    app.get(
      '/api/v1/projects/:id/env',
      {
        preHandler: requireRole('member'),
        schema: {
          tags: ['env'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.array(EnvVar) },
        },
      },
      async (req) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) => tx<{ key: string; preview: string; updated_at: Date }[]>`
          select key, preview, updated_at from env_vars where project_id = ${req.params.id} order by key`,
        );
        return rows.map((r) => ({
          key: r.key,
          preview: r.preview,
          updatedAt: r.updated_at.toISOString(),
        }));
      },
    );

    // A whole .env file at once (parsed in the browser by parseDotenv), saved in
    // one transaction so a bad entry can't leave half a file imported.
    app.post(
      '/api/v1/projects/:id/env/import',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'env.import' },
        schema: {
          tags: ['env'],
          params: z.object({ id: z.uuid() }),
          body: ImportEnvBody,
          response: { 200: z.object({ imported: z.array(z.string()) }) },
        },
      },
      async (req) => {
        const { id } = req.params;
        const orgId = authOf(req).orgId;
        await withOrg(deps.sql, orgId, async (tx) => {
          const [p] = await tx`select 1 from projects where id = ${id}`;
          if (!p) throw notFound('Project');
          for (const { key, value } of req.body.vars) {
            const env = encrypt(deps.keyring, value, `env:${id}:${key}`);
            await tx`
              insert into env_vars (project_id, org_id, key, ciphertext, dek_ciphertext, key_version, preview)
              values (${id}, ${orgId}, ${key}, ${env.ciphertext}, ${env.dekCiphertext}, ${env.keyVersion}, ${previewSecret(value)})
              on conflict (project_id, key) do update set ciphertext = excluded.ciphertext, dek_ciphertext = excluded.dek_ciphertext,
                key_version = excluded.key_version, preview = excluded.preview, updated_at = now()`;
          }
        });
        const imported = req.body.vars.map((v) => v.key);
        req.auditTarget = { type: 'project', id, metadata: { envKeys: imported } };
        return { imported };
      },
    );

    app.put(
      '/api/v1/projects/:id/env/:key',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'env.put' },
        schema: {
          tags: ['env'],
          params: z.object({ id: z.uuid(), key: EnvVarKey }),
          body: PutEnvVarBody,
          response: { 200: EnvVar },
        },
      },
      async (req) => {
        const { id, key } = req.params;
        const env = encrypt(deps.keyring, req.body.value, `env:${id}:${key}`);
        const preview = previewSecret(req.body.value);
        const row = await withOrg(deps.sql, authOf(req).orgId, async (tx) => {
          const [p] = await tx`select 1 from projects where id = ${id}`;
          if (!p) throw notFound('Project');
          const [r] = await tx<{ updated_at: Date }[]>`
            insert into env_vars (project_id, org_id, key, ciphertext, dek_ciphertext, key_version, preview)
            values (${id}, ${authOf(req).orgId}, ${key}, ${env.ciphertext}, ${env.dekCiphertext}, ${env.keyVersion}, ${preview})
            on conflict (project_id, key) do update set ciphertext = excluded.ciphertext, dek_ciphertext = excluded.dek_ciphertext,
              key_version = excluded.key_version, preview = excluded.preview, updated_at = now()
            returning updated_at`;
          return r;
        });
        req.auditTarget = { type: 'env_var', id: `${id}:${key}` };
        return {
          key,
          preview,
          updatedAt: row?.updated_at.toISOString() ?? new Date().toISOString(),
        };
      },
    );

    app.delete(
      '/api/v1/projects/:id/env/:key',
      {
        preHandler: requireRole('admin'),
        config: { audit: 'env.delete' },
        schema: { tags: ['env'], params: z.object({ id: z.uuid(), key: EnvVarKey }) },
      },
      async (req, reply) => {
        const rows = await withOrg(
          deps.sql,
          authOf(req).orgId,
          (tx) =>
            tx`delete from env_vars where project_id = ${req.params.id} and key = ${req.params.key} returning key`,
        );
        if (rows.length === 0) throw notFound('Environment variable');
        req.auditTarget = { type: 'env_var', id: `${req.params.id}:${req.params.key}` };
        return reply.code(204).send();
      },
    );
  };

async function firstFreeSlug(deps: Deps, base: string): Promise<string> {
  const root = isValidSlug(base) ? base : 'site';
  const taken = new Set(
    (
      await deps.sql<
        { slug: string }[]
      >`select slug from projects where slug = ${root} or slug like ${`${root}-%`}`
    ).map((r) => r.slug),
  );
  if (!taken.has(root)) return root;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
  return `${root}-${Date.now().toString(36)}`;
}

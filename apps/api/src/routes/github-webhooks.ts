import { routeKey } from '@autodeploy/core';
import { transition, withOrg } from '@autodeploy/db';
import { verifyWebhookSignature } from '@autodeploy/github';
import { enqueue } from '@autodeploy/queue';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { forbidden, unavailable } from '../lib/errors.js';
import { createDeployment } from '../services/deployments.js';

// GitHub App webhooks. GitHub expects a 2xx within 10 seconds and never
// retries on its own, so the handler only verifies, deduplicates and records
// work (deployments + jobs), then answers 202. Builds happen in the worker.

type PushEvent = {
  ref: string;
  after: string;
  deleted?: boolean;
  head_commit?: { message?: string } | null;
  repository: { full_name: string; default_branch: string };
  installation?: { id: number };
};

type PullRequestEvent = {
  action: string;
  number: number;
  pull_request: {
    // head.repo is null when the fork has since been deleted.
    head: { sha: string; ref: string; repo?: { full_name: string } | null };
    title: string;
    merged?: boolean;
  };
  repository: { full_name: string };
  installation?: { id: number };
};

type InstallationEvent = {
  action: string;
  installation: { id: number; account: { login: string } };
  /** Who installed it: on an organisation, only its owners can. */
  sender?: { id: number };
};

export async function githubWebhookRoutes(app: FastifyInstance, deps: Deps) {
  // Keep the exact bytes: the signature is over the raw body, not re-serialised JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post(
    '/api/v1/webhooks/github',
    {
      config: { rateLimit: { limit: 600, windowMs: 60_000, key: 'ip' } },
      schema: { hide: true },
      bodyLimit: 5 * 1024 * 1024,
    },
    async (req, reply) => {
      const secret = deps.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) throw unavailable('github_not_configured', 'GitHub webhooks are not configured');
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const sig = req.headers['x-hub-signature-256'];
      if (!verifyWebhookSignature(secret, raw, typeof sig === 'string' ? sig : undefined)) {
        throw forbidden('Invalid webhook signature');
      }
      const deliveryId = String(req.headers['x-github-delivery'] ?? '');
      const event = String(req.headers['x-github-event'] ?? '');
      if (!deliveryId) throw forbidden('Missing delivery id');

      // Redeliveries reuse the delivery id: process each one exactly once.
      const fresh =
        await deps.sql`insert into github_deliveries (delivery_id, event) values (${deliveryId}, ${event})
        on conflict do nothing returning delivery_id`;
      if (fresh.length === 0) return reply.code(200).send({ duplicate: true });

      const body = req.body as Record<string, unknown>;
      let created = 0;
      if (event === 'push') created = await onPush(deps, body as unknown as PushEvent);
      else if (event === 'pull_request')
        created = await onPullRequest(deps, body as unknown as PullRequestEvent);
      else if (event === 'installation')
        await onInstallation(deps, body as unknown as InstallationEvent);
      req.log.info({ deliveryId, event, created }, 'github webhook processed');
      return reply.code(202).send({ accepted: true, deployments: created });
    },
  );
}

async function projectsFor(deps: Deps, fullName: string) {
  return deps.sql<{ id: string; org_id: string; default_branch: string; slug: string }[]>`
    select p.id, p.org_id, p.default_branch, p.slug from projects p join orgs o on o.id = p.org_id
    where lower(p.repo_full_name) = lower(${fullName})
      and p.taken_down_at is null and o.suspended_at is null`;
}

async function onPush(deps: Deps, e: PushEvent): Promise<number> {
  if (e.deleted || !e.ref.startsWith('refs/heads/')) return 0;
  const branch = e.ref.slice('refs/heads/'.length);
  let n = 0;
  for (const p of await projectsFor(deps, e.repository.full_name)) {
    if (branch !== p.default_branch) continue; // other branches deploy via PR previews
    await createDeployment(deps, {
      orgId: p.org_id,
      projectId: p.id,
      kind: 'production',
      trigger: 'push',
      ref: branch,
      commitSha: e.after,
      commitMessage: e.head_commit?.message?.split('\n')[0] ?? null,
      branch,
    });
    n++;
  }
  return n;
}

async function onPullRequest(deps: Deps, e: PullRequestEvent): Promise<number> {
  const projects = await projectsFor(deps, e.repository.full_name);
  if (e.action === 'closed') {
    // Retire the PR's previews so they stop resolving; artifacts age out via retention.
    for (const p of projects) {
      await withOrg(deps.sql, p.org_id, async (tx) => {
        const live = await tx<{ id: string }[]>`select id from deployments
          where project_id = ${p.id} and kind = 'preview' and pr_number = ${e.number} and status = 'READY' for update`;
        for (const d of live)
          await transition(tx, {
            deploymentId: d.id,
            to: 'SUPERSEDED',
            payload: { reason: 'pull request closed' },
          });
        await enqueue(
          tx,
          'routes.remove',
          { key: routeKey({ kind: 'preview', slug: p.slug, pr: e.number }) },
          { orgId: p.org_id },
        );
      });
    }
    return 0;
  }
  if (!['opened', 'synchronize', 'reopened'].includes(e.action)) return 0;
  // From a fork: someone else's code, so it builds and runs without the
  // project's variables (it could print them into the public preview).
  const fromFork =
    e.pull_request.head.repo?.full_name.toLowerCase() !== e.repository.full_name.toLowerCase();
  let n = 0;
  for (const p of projects) {
    await createDeployment(deps, {
      orgId: p.org_id,
      projectId: p.id,
      kind: 'preview',
      trigger: 'pull_request',
      ref: e.pull_request.head.ref,
      commitSha: e.pull_request.head.sha,
      commitMessage: e.pull_request.title,
      branch: e.pull_request.head.ref,
      prNumber: e.number,
      fromFork,
    });
    n++;
  }
  return n;
}

async function onInstallation(deps: Deps, e: InstallationEvent) {
  if (e.action === 'created') {
    await deps.sql`insert into github_installations (id, account_login, installed_by)
      values (${e.installation.id}, ${e.installation.account.login}, ${e.sender?.id ?? null})
      on conflict (id) do update set account_login = excluded.account_login,
        installed_by = coalesce(github_installations.installed_by, excluded.installed_by)`;
  } else if (e.action === 'deleted') {
    await deps.sql`delete from github_installations where id = ${e.installation.id}`;
  }
}

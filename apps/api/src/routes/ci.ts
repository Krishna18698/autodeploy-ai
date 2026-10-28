import {
  CI_MAX_LINE_CHARS,
  CI_MAX_LOG_LINES,
  CI_MAX_PARTS,
  CI_PART_MAX_BYTES,
  CI_WORKFLOW_PATH,
  type CiDone,
  type CiState,
  ciAudience,
  ciKeys,
  ciPartKey,
} from '@autodeploy/core';
import { safeEqual } from '@autodeploy/crypto';
import { loadProjectSecrets } from '@autodeploy/db';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError } from '../lib/errors.js';
import {
  type GitHubJobClaims,
  githubSigningKeys,
  type KeyLookup,
  OidcError,
  verifyGitHubJobToken,
} from '../lib/github-oidc.js';

// Where a build running in the user's own GitHub Actions reports back (ADR
// 0010). The worker writes the attempt's state (ciKeys) before it starts the
// workflow; every call here must carry a GitHub job token for that project's
// repository, from AutoDeploy's workflow, plus the attempt's one-time nonce,
// and the first run to call claims the attempt. Output parts go to object
// storage, counted against the attempt's size cap.

const TTL_S = 2 * 3600; // outlives any build (15 min + queueing)
const forbid = (msg: string) => new AppError(403, 'ci_forbidden', msg);

export const ciRoutes =
  (deps: Deps, key: KeyLookup = githubSigningKeys()): FastifyPluginAsyncZod =>
  async (app) => {
    // This plugin only (fastify scopes it): output parts arrive as raw bytes.
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: CI_PART_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    async function authorize(req: FastifyRequest) {
      const attemptId = req.headers['x-autodeploy-attempt'];
      const nonce = req.headers['x-autodeploy-nonce'];
      const auth = req.headers.authorization;
      if (
        typeof attemptId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(attemptId) ||
        typeof nonce !== 'string' ||
        typeof auth !== 'string' ||
        !auth.startsWith('Bearer ')
      )
        throw new AppError(
          401,
          'ci_unauthorized',
          'A GitHub job token, an attempt and its nonce are required.',
        );
      const k = ciKeys(attemptId);
      const raw = await deps.valkey.get(k.state);
      if (!raw)
        throw new AppError(
          404,
          'ci_unknown_attempt',
          'No build is waiting for this attempt; it ended, or never started.',
        );
      const state = JSON.parse(raw) as CiState;
      if (!safeEqual(nonce, state.nonce)) throw forbid('Wrong nonce for this attempt.');
      let claims: GitHubJobClaims;
      try {
        claims = await verifyGitHubJobToken(auth.slice('Bearer '.length), {
          audience: ciAudience(deps.env.API_PUBLIC_URL),
          key,
        });
      } catch (err) {
        if (err instanceof OidcError) throw forbid(`GitHub job token refused: ${err.message}.`);
        throw err; // GitHub's keys unreachable: a 500, which the runner retries
      }
      if (claims.repository.toLowerCase() !== state.repo)
        throw forbid('This build belongs to another repository.');
      if (claims.event_name !== 'workflow_dispatch')
        throw forbid('Only a run AutoDeploy started may report a build.');
      if (!claims.workflow_ref.toLowerCase().startsWith(`${state.repo}/${CI_WORKFLOW_PATH}@`))
        throw forbid(`Only ${CI_WORKFLOW_PATH} may report a build.`);
      // One run per attempt: the first to call claims it.
      const claimed = await deps.valkey.set(k.run, claims.run_id, 'EX', TTL_S, 'NX');
      if (claimed !== 'OK' && (await deps.valkey.get(k.run)) !== claims.run_id)
        throw new AppError(409, 'ci_claimed', 'Another run already claimed this build.');
      if (await deps.valkey.exists(k.done))
        throw new AppError(409, 'ci_finished', 'This build already finished.');
      return { attemptId, state, k };
    }

    const config = {
      ownAuth: true as const,
      csrf: false as const,
      rateLimit: { limit: 600, windowMs: 60_000 },
    };

    app.post('/ci/v1/start', { config, schema: { hide: true } }, async (req) => {
      const { state } = await authorize(req);
      const [d] = await deps.sql<{ from_fork: boolean }[]>`
        select from_fork from deployments where id = ${state.deploymentId}`;
      if (!d) throw new AppError(404, 'ci_unknown_attempt', 'This deployment no longer exists.');
      // A pull request from a fork gets none of the project's variables (as in the sandbox).
      const env = d.from_fork
        ? {}
        : await loadProjectSecrets(deps.sql, deps.keyring, state.projectId);
      return { env };
    });

    app.post(
      '/ci/v1/log',
      {
        config,
        schema: {
          hide: true,
          body: z.object({ lines: z.array(z.string().max(CI_MAX_LINE_CHARS)).max(500) }),
        },
      },
      async (req, reply) => {
        const { k } = await authorize(req);
        const { lines } = req.body;
        if (lines.length > 0) {
          const total = await deps.valkey.incrby(k.logCount, lines.length);
          if (total > CI_MAX_LOG_LINES)
            throw new AppError(
              413,
              'ci_log_too_long',
              `A build's log may have ${CI_MAX_LOG_LINES} lines.`,
            );
          await deps.valkey
            .multi()
            .rpush(k.log, ...lines)
            .expire(k.log, TTL_S)
            .expire(k.logCount, TTL_S)
            .exec();
        }
        return reply.code(204).send();
      },
    );

    app.put(
      '/ci/v1/parts/:n',
      {
        config,
        bodyLimit: CI_PART_MAX_BYTES,
        schema: {
          hide: true,
          params: z.object({
            n: z.coerce
              .number()
              .int()
              .min(0)
              .max(CI_MAX_PARTS - 1),
          }),
        },
      },
      async (req, reply) => {
        const { attemptId, state, k } = await authorize(req);
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0)
          throw new AppError(400, 'ci_bad_part', 'Send the part as application/octet-stream.');
        const total = await deps.valkey.incrby(k.bytes, body.length);
        await deps.valkey.expire(k.bytes, TTL_S);
        if (total > state.maxBytes)
          throw new AppError(
            413,
            'ci_too_big',
            `The build output is bigger than ${Math.round(state.maxBytes / 1048576)} MB (compressed).`,
          );
        await deps.storage.put(
          ciPartKey(attemptId, req.params.n),
          body,
          'application/octet-stream',
        );
        return reply.code(204).send();
      },
    );

    app.post(
      '/ci/v1/finish',
      {
        config,
        schema: {
          hide: true,
          body: z.object({
            exitCode: z.number().int(),
            parts: z.number().int().min(0).max(CI_MAX_PARTS),
            bytes: z.number().int().min(0),
          }),
        },
      },
      async (req, reply) => {
        const { k } = await authorize(req);
        const done: CiDone = req.body;
        if ((await deps.valkey.set(k.done, JSON.stringify(done), 'EX', TTL_S, 'NX')) !== 'OK')
          throw new AppError(409, 'ci_finished', 'This build already finished.');
        return reply.code(204).send();
      },
    );
  };

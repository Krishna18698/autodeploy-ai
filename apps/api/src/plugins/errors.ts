import { IllegalTransitionError } from '@autodeploy/core';
import { StaleTransitionError } from '@autodeploy/db';
import { GitHubError } from '@autodeploy/github';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function sendProblem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `https://autodeploy.dev/problems/${code}`,
      title: TITLES[status] ?? 'Error',
      status,
      code,
      detail,
      instance: reply.request.url,
      ...extra,
    });
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors = err.validation.map((v) => ({
        path: `${err.validationContext ?? 'body'}${v.instancePath.replaceAll('/', '.')}`,
        message: v.message ?? 'invalid',
      }));
      return sendProblem(reply, 400, 'validation_failed', 'The request did not match the schema.', {
        errors,
      });
    }
    if (err instanceof AppError) {
      for (const [k, v] of Object.entries(err.extra?.headers ?? {})) reply.header(k, v);
      return sendProblem(
        reply,
        err.status,
        err.code,
        err.message,
        err.extra?.errors ? { errors: err.extra.errors } : {},
      );
    }
    // GitHub said no: say why, instead of a bare 500.
    if (err instanceof GitHubError) {
      if (err.status === 404)
        return sendProblem(
          reply,
          404,
          'repo_not_found',
          'AutoDeploy can\'t see this repository or branch. If it\'s private, give the AutoDeploy GitHub App access to it ("Add repositories on GitHub" above), then try again.',
        );
      if (err.retryAfterMs !== undefined || err.status === 429) {
        reply.header('retry-after', String(Math.ceil((err.retryAfterMs ?? 60_000) / 1000)));
        return sendProblem(reply, 503, 'github_rate_limited', err.message);
      }
      req.log.warn({ err }, 'github request failed');
      return sendProblem(reply, 502, 'github_error', `GitHub request failed: ${err.message}`);
    }
    if (err instanceof IllegalTransitionError || err instanceof StaleTransitionError) {
      return sendProblem(reply, 409, 'invalid_state', err.message);
    }
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === '23505')
      return sendProblem(
        reply,
        409,
        'already_exists',
        `Conflicts with an existing record (${pg.constraint_name ?? 'unique'}).`,
      );
    if (pg.code === '23514')
      return sendProblem(reply, 409, 'invalid_state', 'The change violates a database rule.');
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return sendProblem(reply, fe.statusCode, fe.code?.toLowerCase() ?? 'bad_request', fe.message);
    }
    req.log.error({ err }, 'unhandled error');
    return sendProblem(
      reply,
      500,
      'internal',
      'Something went wrong. The error was logged with this request id.',
      { requestId: req.id },
    );
  });

  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, 404, 'route_not_found', `No route for ${req.method} ${req.url}`),
  );
}

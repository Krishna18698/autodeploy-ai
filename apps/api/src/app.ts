import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Deps } from './deps.js';
import { auditPlugin } from './plugins/audit.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/errors.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { clientErrorRoutes } from './routes/client-errors.js';
import { deploymentRoutes } from './routes/deployments.js';
import { githubWebhookRoutes } from './routes/github-webhooks.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { orgRoutes } from './routes/org.js';
import { projectRoutes } from './routes/projects.js';

export async function buildApp(deps: Deps) {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-token"]',
      ],
      ...(env.NODE_ENV === 'development' &&
        process.stdout.isTTY && { transport: { target: 'pino-pretty' } }),
    },
    // Honour an upstream request id (Cloudflare / Caddy) so one id follows
    // the request across hops; otherwise mint one.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(helmet, {
    // The API serves JSON (and the docs page); lock everything else down.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: [env.APP_URL],
    credentials: true,
    allowedHeaders: [
      'content-type',
      'x-csrf-token',
      'idempotency-key',
      'authorization',
      'if-match',
      'last-event-id',
    ],
    exposedHeaders: [
      'etag',
      'x-request-id',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
      'idempotent-replayed',
    ],
  });
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AutoDeploy API',
        version: '1.0.0',
        description: 'Self-healing deployments for static sites and server-rendered Next.js apps.',
      },
      servers: [{ url: env.API_PUBLIC_URL }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'ad_session' },
          token: { type: 'http', scheme: 'bearer', description: 'API token (adp_…)' },
        },
      },
      security: [{ token: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { theme: 'deepSpace', darkMode: true },
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(authPlugin, deps);
  await app.register(rateLimitPlugin, {
    valkey: deps.valkey,
    defaultPerMinute: env.RATE_LIMIT_PER_MINUTE,
  });
  await app.register(idempotencyPlugin, { sql: deps.sql });
  await app.register(auditPlugin, { sql: deps.sql });

  await app.register(async (scope) => healthRoutes(scope, deps));
  await app.register(authRoutes(deps));
  await app.register(projectRoutes(deps));
  await app.register(deploymentRoutes(deps));
  await app.register(orgRoutes(deps));
  await app.register(internalRoutes(deps));
  await app.register(clientErrorRoutes(deps));
  // Encapsulated so its raw-body JSON parser doesn't affect other routes.
  await app.register(async (scope) => githubWebhookRoutes(scope, deps));

  return app;
}

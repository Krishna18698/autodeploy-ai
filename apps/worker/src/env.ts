import { hostname } from 'node:os';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Errors go to Sentry when set (and nowhere else otherwise).
  SENTRY_DSN: z.url().optional(),
  WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),
  PLATFORM_DOMAIN: z.string().min(1),
  APP_URL: z.url().default('http://localhost:3000'),
  // Where GitHub sends webhooks: missed ones are resent only once it answers.
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  KAFKA_BROKERS: z
    .string()
    .default('127.0.0.1:9092')
    .transform((s) => s.split(',').map((b) => b.trim())),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  ENCRYPTION_KEYS: z.string().min(1),
  WORK_DIR: z.string().default('/tmp/autodeploy'),
  ALLOW_LOCAL_SOURCES: bool,
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),

  // Concurrency: builds are heavy (2 OCPU box), everything else is light.
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  LIGHT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PER_ORG_BUILD_LIMIT: z.coerce.number().int().min(1).default(1),
  LEASE_MS: z.coerce.number().int().min(5_000).default(30_000),

  // Sandbox
  SANDBOX_RUNTIME: z.enum(['runc', 'runsc']).default('runc'),
  // ---- SSR runtime gateway (ADR 0008) ----
  INTERNAL_TOKEN: z.string().min(24).optional(),
  GATEWAY_PORT: z.coerce.number().int().default(8082),
  RUNTIME_NETWORK: z.string().default('autodeploy-runtime'),
  RUNTIME_PROXY: z.string().default('http://egress-runtime:3129'),
  /** 'network': reach containers by name on RUNTIME_NETWORK (prod); 'publish': via a localhost port (dev). */
  RUNTIME_REACH: z.enum(['network', 'publish']).default('network'),
  RUNTIME_BUNDLES_DIR: z.string().default('/var/lib/autodeploy/runtimes'),
  RUNTIME_MEMORY: z.string().default('256m'),
  /**
   * A site may use a whole CPU when the VM has it to spare (Next.js starts up
   * about twice as fast as on half of one; capacity test, 2026-10-24) ...
   */
  RUNTIME_CPUS: z.string().default('1'),
  /**
   * ... but counts half as much as a platform service (Docker's default weight
   * is 1024) when CPU is short, so a busy site slows the API, database and
   * gateway half as much as an equally busy service would.
   */
  RUNTIME_CPU_SHARES: z.coerce.number().int().min(2).max(1024).default(512),
  RUNTIME_IDLE_MIN: z.coerce.number().min(1).default(15),
  RUNTIME_MAX_AWAKE: z.coerce.number().int().min(1).default(20),
  /**
   * The VM's memory (MiB) a server may never wake into: a build's worth
   * (SANDBOX_MEMORY) plus 1 GiB, so the next build fits and Postgres and the
   * rest are never squeezed. Below half of it, idle servers are put to sleep.
   */
  RUNTIME_MIN_FREE_MB: z.coerce.number().int().min(0).default(4096),
  RUNTIME_START_TIMEOUT_S: z.coerce.number().int().min(5).default(30),
  // Free B2 storage is 10 GB in all, and bundles are kept per deployment.
  RUNTIME_BUNDLE_MAX_MB: z.coerce.number().int().min(10).default(300),
  /** Unpacked bundles on the VM's disk unused this long (and not live or running) are deleted. */
  RUNTIME_BUNDLE_KEEP_H: z.coerce.number().min(1).default(24),
  SANDBOX_NETWORK: z.string().default('autodeploy_sandbox'),
  SANDBOX_PROXY: z.string().default('http://egress:3128'),
  SANDBOX_IMAGE_PREFIX: z.string().default('autodeploy-build:node'),
  SANDBOX_CPUS: z.string().default('1.5'),
  SANDBOX_MEMORY: z.string().default('3g'),
  BUILD_TIMEOUT_S: z.coerce.number().int().min(30).default(900),
  VALIDATOR: z.enum(['docker', 'skip']).default('docker'),
  VALIDATOR_IMAGE: z.string().default('autodeploy-validator:latest'),
  // A validation takes well under a minute (a server start is capped at 30 s inside).
  VALIDATE_TIMEOUT_S: z.coerce.number().int().min(30).default(180),

  // AI providers (all optional; with none set, recovery is rules-only)
  AI_PROVIDERS: z
    .string()
    .default('')
    .describe('comma list in priority order: nvidia,openrouter,cloudflare,mock'),
  NVIDIA_API_KEY: z.string().optional(),
  // Checked 2026-10-18 on the free endpoint: answers in ~1 s with thinking off;
  // deepseek-v4.1-flash and the GLM models never answered (no reply in 150 s).
  NVIDIA_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b'),
  NVIDIA_THINKING: z.enum(['on', 'off', 'default']).default('off'),
  OPENROUTER_API_KEY: z.string().optional(),
  // Free models come and go; checked against openrouter.ai/api/v1/models 2026-10-07.
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
  CF_ACCOUNT_ID: z.string().optional(),
  CF_AI_TOKEN: z.string().optional(),
  CF_AI_MODEL: z.string().default('@cf/qwen/qwen3-30b-a3b-fp8'),
  // A repair model on Cloudflare's own hardware, so a model NVIDIA withdraws
  // (both other providers serve NVIDIA's) doesn't stop AI repair.
  CF_REPAIR_MODEL: z.string().default('@cf/openai/gpt-oss-120b'),
  AI_DAILY_CALL_BUDGET: z.coerce.number().int().min(0).default(300),
  // One account's share (a repair is about three calls).
  AI_CALLS_PER_ORG_PER_DAY: z.coerce.number().int().min(0).default(60),

  // Edge routes (Cloudflare KV); unset = local mode (edge asks the API)
  CF_KV_NAMESPACE_ID: z.string().optional(),
  CF_KV_API_TOKEN: z.string().optional(),

  // Email (Resend); unset = log emails instead of sending
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('AutoDeploy <deploys@autodeploy.localhost>'),

  METRICS_PORT: z.coerce.number().int().default(9464),
  RETENTION_KEEP_PER_PROJECT: z.coerce.number().int().min(1).default(10),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return parsed.data;
}

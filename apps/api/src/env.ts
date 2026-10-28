import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');
const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

// Parsed once at boot: a missing or malformed variable stops the process
// before it accepts traffic, instead of failing on the first request.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Errors go to Sentry when set (and nowhere else otherwise).
    SENTRY_DSN: z.url().optional(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    PLATFORM_DOMAIN: z.string().min(1),
    // Users' sites live on their own registrable domain (on the Public Suffix
    // List), so a site can't set cookies for the dashboard or get its domain
    // flagged. Unset: sites share PLATFORM_DOMAIN (local development).
    SITES_DOMAIN: z
      .string()
      .optional()
      .transform((v) => v || undefined),
    APP_URL: z.url().default('http://localhost:3000'),
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    /** Server-rendered projects per org: each can hold a container awake (ADR 0008). */
    SSR_PROJECTS_PER_ORG: z.coerce.number().int().min(0).default(3),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    ENCRYPTION_KEYS: z.string().min(1).describe('"1:<base64 32 bytes>[,2:…]"'),
    INTERNAL_TOKEN: z.string().min(24),
    WORK_DIR: z.string().default('/tmp/autodeploy'),
    DEV_LOGIN: bool,
    ALLOW_LOCAL_SOURCES: bool,
    // Empty: anyone can sign in or sign up (usage is limited per account,
    // below). Set it to restrict sign-in to listed GitHub logins; new email
    // sign-ups are closed while it is set.
    ALLOWED_GITHUB_LOGINS: list,
    // GitHub account ids (numeric, they never change hands) allowed to take
    // sites down and suspend accounts: Admin in the dashboard.
    PLATFORM_ADMIN_GITHUB_IDS: list,
    // Account email (verify address, reset password). Unset: logged, not sent.
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('AutoDeploy <onboarding@resend.dev>'),
    // Per-account limits (one personal org per user).
    MAX_PROJECTS_PER_ORG: z.coerce.number().int().min(1).default(10),
    BUILD_MINUTES_PER_MONTH: z.coerce.number().int().min(1).default(300),
    STORAGE_MB_PER_ORG: z.coerce.number().int().min(1).default(1024),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_SLUG: z.string().optional(),
    GITHUB_APP_CLIENT_ID: z.string().optional(),
    GITHUB_APP_CLIENT_SECRET: z.string().optional(),
    /** Sign in with Google (an OAuth web client; redirect: <API_PUBLIC_URL>/auth/google/callback). */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production') {
      if (e.DEV_LOGIN)
        ctx.addIssue({
          code: 'custom',
          path: ['DEV_LOGIN'],
          message: 'must be false in production',
        });
      if (e.ALLOW_LOCAL_SOURCES)
        ctx.addIssue({
          code: 'custom',
          path: ['ALLOW_LOCAL_SOURCES'],
          message: 'must be false in production',
        });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export function googleConfigured(
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function githubAppConfigured(env: Env): boolean {
  return Boolean(
    env.GITHUB_APP_ID &&
      env.GITHUB_APP_CLIENT_ID &&
      env.GITHUB_APP_CLIENT_SECRET &&
      env.GITHUB_APP_PRIVATE_KEY,
  );
}

/** The domain users' sites are served under. */
export const sitesDomain = (env: Pick<Env, 'SITES_DOMAIN' | 'PLATFORM_DOMAIN'>) =>
  env.SITES_DOMAIN ?? env.PLATFORM_DOMAIN;

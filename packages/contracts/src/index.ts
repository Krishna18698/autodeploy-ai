import { DEPLOYMENT_STATUSES } from '@autodeploy/core/state-machine';
import { z } from 'zod';

// Wire contracts shared by the API, the dashboard and the CLI. The API derives
// its OpenAPI document from these, so docs and validation can't drift.

export const Id = z.uuid();
export const Timestamp = z.string().describe('ISO 8601 timestamp');

// --- errors (RFC 9457) -----------------------------------------------------
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// --- auth / orgs -----------------------------------------------------------
export const Role = z.enum(['owner', 'admin', 'member', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Me = z.object({
  user: z.object({
    id: Id,
    login: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    email: z.string().nullable().describe('Where failure and approval emails go'),
    githubConnected: z
      .boolean()
      .describe('false for an email account that has not linked a GitHub account'),
  }),
  org: z.object({ id: Id, slug: z.string(), name: z.string(), role: Role }),
  orgs: z.array(z.object({ id: Id, slug: z.string(), name: z.string(), role: Role })),
  csrfToken: z.string().nullable(),
});

export const Member = z.object({
  userId: Id,
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: Role,
  joinedAt: Timestamp,
});

export const AddMemberBody = z.object({ login: z.string().min(1), role: Role.exclude(['owner']) });
/** An invitation as the invited person sees it. */
export const Invitation = z.object({
  id: Id,
  org: z.object({ id: Id, name: z.string(), slug: z.string() }),
  role: Role,
  invitedBy: z.string().nullable(),
  createdAt: Timestamp,
});
/** A pending invitation as the org's admins see it. */
export const PendingInvitation = z.object({
  id: Id,
  login: z.string(),
  role: Role,
  createdAt: Timestamp,
});
export const UpdateMemberBody = z.object({ role: Role });

// --- analysis --------------------------------------------------------------
const Evidence = z.object({ source: z.string(), detail: z.string() });
const Inference = <T extends z.ZodType>(v: T) =>
  z.object({ value: v, evidence: z.array(Evidence) });

export const ServerSpec = z.object({
  bundle: z.enum(['next-standalone', 'output-dir', 'project']),
  dir: z.string().optional(),
  start: z.string().describe('Starts the server; it must listen on $PORT'),
  assets: z.string().optional(),
});

export const Analysis = z.object({
  rootDir: z.string(),
  framework: Inference(z.string()).extend({ version: z.string().optional() }),
  packageManager: Inference(z.string()).extend({ version: z.string().optional() }),
  node: Inference(z.number()).extend({ range: z.string().optional() }),
  installCommand: Inference(z.string().nullable()),
  buildCommand: Inference(z.string().nullable()),
  outputDir: Inference(z.string()),
  mode: Inference(z.enum(['static', 'ssr', 'unknown'])),
  server: Inference(ServerSpec).optional(),
  basePath: z.string().optional(),
  envVars: Inference(z.array(z.string())),
  monorepo: z.boolean(),
  supported: z.boolean(),
  unsupportedReason: z.string().optional(),
  warnings: z.array(z.string()),
});

export const GitHubRepos = z.object({
  configured: z.boolean().describe('false when the server has no GitHub App'),
  githubConnected: z.boolean().describe('false until the account is linked to GitHub'),
  installUrl: z.string().nullable().describe('Where to give the App access to more repos'),
  accounts: z.array(z.string()),
  repos: z.array(
    z.object({
      fullName: z.string(),
      private: z.boolean(),
      defaultBranch: z.string(),
      pushedAt: Timestamp.nullable(),
      url: z.string(),
      imported: z.boolean(),
      /** Already a project at the repo root: the picker links to it instead of importing again. */
      projectId: Id.nullable(),
    }),
  ),
});

/** A directory inside the repository: relative, without ".." or absolute paths. */
export const RepoDir = z
  .string()
  .max(200)
  .regex(
    /^(?:\.|(?:\.\/)?(?!\.\.?(?:\/|$))[\w@+.-]+(?:\/(?!\.\.?(?:\/|$))[\w@+.-]+)*\/?)$/,
    'a path inside the repository, like apps/web or dist',
  );

export const AnalyzeBody = z.object({
  repoUrl: z.url().describe('Public GitHub repository URL, e.g. https://github.com/owner/repo'),
  ref: z.string().max(200).optional(),
  rootDir: RepoDir.default('.'),
});
export const AnalyzeResult = z.object({
  repo: z.object({ fullName: z.string(), ref: z.string(), commitSha: z.string() }),
  analysis: Analysis,
  suggestedSlug: z.string(),
});

// --- projects --------------------------------------------------------------
export const BuildSettings = z.object({
  nodeVersion: z.number().int().nullable(),
  installCommand: z.string().max(500).nullable(),
  buildCommand: z.string().max(500).nullable(),
  outputDir: RepoDir.nullable(),
  rootDir: RepoDir,
  aiRepair: z
    .boolean()
    .describe("Send a failed build's log excerpt and related files to AI providers for a fix"),
});

export const Project = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  repoFullName: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  framework: z.string(),
  url: z.string(),
  settings: BuildSettings,
  executor: z.enum(['sandbox', 'github_actions']),
  analysis: Analysis.nullable(),
  activeDeploymentId: Id.nullable(),
  latestDeployment: z
    .object({
      id: Id,
      number: z.number(),
      status: z.enum(DEPLOYMENT_STATUSES),
      createdAt: Timestamp,
    })
    .nullable(),
  version: z.number().int(),
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z.object({
  repoUrl: z.url(),
  name: z.string().min(1).max(80).optional(),
  slug: z.string().min(1).max(40).optional(),
  rootDir: RepoDir.default('.'),
  deploy: z.boolean().default(true),
});

export const UpdateProjectBody = z
  .object({
    name: z.string().min(1).max(80),
    defaultBranch: z.string().min(1).max(200),
    executor: z.enum(['sandbox', 'github_actions']),
  })
  .merge(BuildSettings)
  .partial();

export const SlugAvailability = z.object({
  slug: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
  domain: z.string().describe('Sites are served at <slug>.<domain>'),
});

// --- env vars ---------------------------------------------------------------
export const EnvVarKey = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'UPPER_SNAKE_CASE');
export const EnvVar = z.object({ key: z.string(), updatedAt: Timestamp, preview: z.string() });
export const PutEnvVarBody = z.object({ value: z.string().max(8192) });
export const ImportEnvBody = z.object({
  vars: z
    .array(z.object({ key: EnvVarKey, value: z.string().max(8192) }))
    .min(1)
    .max(200)
    .describe('From a .env file; existing keys are overwritten'),
});

// --- deployments -----------------------------------------------------------
export const DeploymentStatus = z.enum(DEPLOYMENT_STATUSES);

export const BuildConfig = z.object({
  nodeVersion: z.number(),
  installCommand: z.string().nullable(),
  buildCommand: z.string().nullable(),
  outputDir: z.string(),
  rootDir: z.string(),
  env: z.record(z.string(), z.string()),
  patch: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  mode: z.enum(['static', 'ssr']).optional(),
  server: ServerSpec.optional(),
});

export const Attempt = z.object({
  id: Id,
  attemptNo: z.number(),
  executor: z.string(),
  status: z.enum(['running', 'succeeded', 'failed', 'canceled']),
  config: BuildConfig,
  errorCode: z.string().nullable(),
  errorSignature: z.string().nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  durationMs: z.number().nullable(),
});

export const Deployment = z.object({
  id: Id,
  projectId: Id,
  projectSlug: z.string(),
  number: z.number(),
  status: DeploymentStatus,
  kind: z.enum(['production', 'preview']),
  trigger: z.enum(['manual', 'push', 'pull_request', 'redeploy', 'cli']),
  commitSha: z.string().nullable(),
  commitMessage: z.string().nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().nullable(),
  url: z.string().nullable(),
  previewUrl: z.string().nullable(),
  screenshotUrl: z.string().nullable(),
  errorSummary: z.string().nullable(),
  recoveredBy: z.enum(['rule', 'ai']).nullable(),
  /** 'ssr': runs as a server that wakes on demand (ADR 0008). */
  mode: z.enum(['static', 'ssr']),
  runtime: z
    .object({
      status: z.enum(['starting', 'running', 'stopped', 'failed']),
      lastRequestAt: Timestamp.nullable(),
      coldStartMs: z.number().nullable(),
      requests: z.number(),
      error: z.string().nullable(),
    })
    .nullable()
    .describe('SSR only: the server process, if it has ever been started'),
  attempts: z.array(Attempt),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type Deployment = z.infer<typeof Deployment>;

export const DeploymentSummary = Deployment.omit({ attempts: true }).extend({
  attemptCount: z.number(),
});

export const CreateDeploymentBody = z.object({
  ref: z
    .string()
    .max(200)
    .optional()
    .describe('Branch, tag or commit SHA. Defaults to the default branch.'),
  kind: z.enum(['production', 'preview']).default('production'),
});

export const RollbackBody = z.object({ deploymentId: Id });

export const DeploymentEvent = z.object({
  id: z.string(),
  type: z.string(),
  fromStatus: DeploymentStatus.nullable(),
  toStatus: DeploymentStatus.nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});

export const LogLine = z.object({ seq: z.number(), attemptNo: z.number(), text: z.string() });
export const LogPage = z.object({
  lines: z.array(LogLine),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
});

// --- repairs ---------------------------------------------------------------
export const Repair = z.object({
  id: Id,
  deploymentId: Id,
  attemptNo: z.number(),
  errorCode: z.string(),
  errorSignature: z.string(),
  strategy: z.enum(['rule', 'ai']),
  ruleId: z.string().nullable(),
  title: z.string(),
  explanation: z.string(),
  diagnosis: z
    .object({
      summary: z.string(),
      cause: z.string(),
      filesRead: z.array(z.string()),
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .nullable(),
  configChanges: z.array(
    z.object({
      field: z.string(),
      from: z.unknown().nullable().optional(),
      to: z.unknown().nullable().optional(),
    }),
  ),
  diff: z.string().nullable(),
  policy: z
    .object({
      allowed: z.boolean(),
      violations: z.array(
        z.object({ path: z.string().optional(), rule: z.string(), detail: z.string() }),
      ),
      approvalReasons: z.array(z.string()),
    })
    .nullable(),
  status: z.enum([
    'proposed',
    'applied',
    'validated',
    'failed',
    'awaiting_approval',
    'approved',
    'rejected',
  ]),
  needsApproval: z.boolean(),
  prUrl: z.string().nullable(),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable(),
});
export type Repair = z.infer<typeof Repair>;

// --- tokens ----------------------------------------------------------------
export const TokenScope = z.enum(['deploy', 'read', 'admin']);
export const ApiToken = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(TokenScope),
  expiresAt: Timestamp.nullable(),
  lastUsedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export const CreateTokenBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(TokenScope).min(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});
export const CreatedToken = ApiToken.extend({ token: z.string().describe('Shown once') });

// --- outbound webhooks -----------------------------------------------------
export const WEBHOOK_EVENTS = [
  'deployment.created',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.activated',
  'deployment.rolled_back',
  'repair.awaiting_approval',
] as const;
export const WebhookEndpoint = z.object({
  id: Id,
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  active: z.boolean(),
  createdAt: Timestamp,
});
export const CreateWebhookBody = z.object({
  url: z
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), 'must be https'),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});
export const CreatedWebhook = WebhookEndpoint.extend({ secret: z.string().describe('Shown once') });
export const WebhookDelivery = z.object({
  id: Id,
  eventType: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed', 'dead']),
  attempts: z.number(),
  responseStatus: z.number().nullable(),
  responseMs: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: Timestamp,
});

// --- audit / analytics -----------------------------------------------------
export const AuditEvent = z.object({
  id: z.string(),
  action: z.string(),
  actor: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});

export const AnalyticsSummary = z.object({
  days: z.number(),
  totals: z.object({
    deployments: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    recoveredByRule: z.number(),
    recoveredByAi: z.number(),
    escalated: z.number(),
  }),
  buildMs: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
  queueWaitMs: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
  daily: z.array(
    z.object({
      day: z.string(),
      deployments: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      p95BuildMs: z.number().nullable(),
    }),
  ),
  topSignatures: z.array(z.object({ code: z.string(), count: z.number() })),
  ai: z.array(
    z.object({
      provider: z.string(),
      calls: z.number(),
      failures: z.number(),
      avgLatencyMs: z.number().nullable(),
    }),
  ),
  consumers: z.array(z.object({ group: z.string(), lag: z.number().nullable(), dlq: z.number() })),
});

export const Quota = z.object({
  deploysToday: z.number(),
  /** Same as deploysPerDay (kept for older dashboards). */
  dailyLimit: z.number(),
  deploysPerDay: z.number(),
  projects: z.number(),
  projectLimit: z.number(),
  serverProjects: z.number(),
  serverProjectLimit: z.number(),
  buildMinutesThisMonth: z.number(),
  buildMinutesPerMonth: z.number(),
  storageBytes: z.number(),
  storageLimitBytes: z.number(),
});

// --- domain events (Kafka + SSE) ------------------------------------------
export const DomainEvent = z.object({
  id: z.string().describe('ULID; also the idempotency key for consumers'),
  type: z.string(),
  occurredAt: Timestamp,
  orgId: Id,
  projectId: Id.nullable(),
  deploymentId: Id.nullable(),
  data: z.record(z.string(), z.unknown()),
  traceparent: z.string().optional(),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

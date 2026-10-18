import {
  AiGateway,
  MockProvider,
  nvidia,
  openrouter,
  type Provider,
  workersAi,
} from '@autodeploy/ai';
import { type Keyring, parseKeyring } from '@autodeploy/crypto';
import {
  CloudflareKvRouteStore,
  createSql,
  PostgresRouteStore,
  type RouteStore,
  type Sql,
} from '@autodeploy/db';
import { createProducer, type KafkaConfig, type KafkaProducer } from '@autodeploy/events';
import { GitHubClient, InstallationTokens } from '@autodeploy/github';
import { Storage } from '@autodeploy/storage';
import { createLogger, type Logger } from '@autodeploy/telemetry';
import { Valkey } from 'iovalkey';
import type { Env } from './env.js';
import { recordAiUsage } from './jobs/recover.js';
import { metrics } from './metrics.js';

export type Deps = {
  env: Env;
  log: Logger;
  sql: Sql;
  valkey: Valkey;
  storage: Storage;
  keyring: Keyring;
  kafka: KafkaConfig;
  producer: KafkaProducer;
  ai: AiGateway;
  routes: RouteStore;
  github: GitHubClient;
  installations: InstallationTokens | null;
  close: () => Promise<void>;
};

function providersFrom(env: Env, log: Logger): Provider[] {
  const out: Provider[] = [];
  for (const name of env.AI_PROVIDERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (name === 'nvidia' && env.NVIDIA_API_KEY)
      out.push(nvidia(env.NVIDIA_API_KEY, env.NVIDIA_MODEL, env.NVIDIA_THINKING));
    else if (name === 'openrouter' && env.OPENROUTER_API_KEY)
      out.push(openrouter(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL));
    else if (name === 'mock') out.push(new MockProvider());
    else log.warn({ provider: name }, 'AI provider listed but not configured; skipping');
  }
  return out;
}

export function createDeps(env: Env): Deps {
  // Assigned below; the AI usage hook needs the finished deps object.
  let self: Deps | undefined;
  const log = createLogger('worker', env.LOG_LEVEL);
  const sql = createSql(env.DATABASE_URL, {
    max: env.BUILD_CONCURRENCY + env.LIGHT_CONCURRENCY + 6,
    application: 'autodeploy-worker',
  });
  const valkey = new Valkey(env.VALKEY_URL, { maxRetriesPerRequest: 2 });
  const kafka: KafkaConfig = {
    brokers: env.KAFKA_BROKERS,
    clientId: `autodeploy-${env.WORKER_ID}`,
  };
  const providers = providersFrom(env, log);
  const classifier =
    env.CF_ACCOUNT_ID && env.CF_AI_TOKEN
      ? workersAi(env.CF_ACCOUNT_ID, env.CF_AI_TOKEN, env.CF_AI_MODEL)
      : undefined;

  const ai = new AiGateway({
    providers,
    ...(classifier && { classifier }),
    onUsage: async (u) => {
      metrics.aiCalls.inc({ provider: u.provider, outcome: u.outcome });
      if (self) await recordAiUsage(self, u);
    },
    budget: async () => {
      const [r] = await sql<
        { n: number }[]
      >`select count(*)::int as n from ai_usage where created_at >= date_trunc('day', now())`;
      return (r?.n ?? 0) < env.AI_DAILY_CALL_BUDGET;
    },
    onBreakerChange: (provider, state) => {
      metrics.breakerState.set({ provider }, state === 'open' ? 1 : 0);
      log.warn({ provider, state }, 'AI provider circuit changed state');
    },
  });

  const routes: RouteStore =
    env.CF_ACCOUNT_ID && env.CF_KV_NAMESPACE_ID && env.CF_KV_API_TOKEN
      ? new CloudflareKvRouteStore({
          accountId: env.CF_ACCOUNT_ID,
          namespaceId: env.CF_KV_NAMESPACE_ID,
          apiToken: env.CF_KV_API_TOKEN,
        })
      : new PostgresRouteStore();

  const installations =
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
      ? new InstallationTokens({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
      : null;

  const producer = createProducer(kafka);
  self = {
    env,
    log,
    sql,
    valkey,
    storage: new Storage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }),
    keyring: parseKeyring(env.ENCRYPTION_KEYS),
    kafka,
    producer,
    ai,
    routes,
    github: new GitHubClient({ ...(env.GITHUB_TOKEN && { token: env.GITHUB_TOKEN }) }),
    installations,
    close: async () => {
      await Promise.allSettled([producer.close(), valkey.quit()]);
      await sql.end({ timeout: 10 });
    },
  };
  return self as Deps;
}

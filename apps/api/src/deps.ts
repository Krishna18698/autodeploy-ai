import { type Keyring, parseKeyring } from '@autodeploy/crypto';
import { createSql, type Sql } from '@autodeploy/db';
import { GitHubClient, InstallationTokens } from '@autodeploy/github';
import { Storage } from '@autodeploy/storage';
import { Valkey } from 'iovalkey';
import { type Env, githubAppConfigured } from './env.js';

export type Deps = {
  env: Env;
  sql: Sql;
  valkey: Valkey;
  storage: Storage;
  keyring: Keyring;
  github: GitHubClient;
  installations: InstallationTokens | null;
  /** Opens a dedicated Valkey connection (blocking reads for SSE). */
  valkeyFactory: () => Valkey;
  close: () => Promise<void>;
};

export function createDeps(env: Env): Deps {
  const sql = createSql(env.DATABASE_URL, { max: 10, application: 'autodeploy-api' });
  const valkey = new Valkey(env.VALKEY_URL, { maxRetriesPerRequest: 2 });
  const storage = new Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  const github = new GitHubClient({
    ...(env.GITHUB_TOKEN && { token: env.GITHUB_TOKEN }),
    cache: { get: (k) => valkey.get(k), set: (k, v, ttl) => valkey.set(k, v, 'EX', ttl) },
  });
  const installations =
    githubAppConfigured(env) && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
      ? new InstallationTokens({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
      : null;
  return {
    env,
    sql,
    valkey,
    storage,
    keyring: parseKeyring(env.ENCRYPTION_KEYS),
    github,
    installations,
    valkeyFactory: () => new Valkey(env.VALKEY_URL, { maxRetriesPerRequest: null }),
    close: async () => {
      await Promise.allSettled([sql.end({ timeout: 5 }), valkey.quit()]);
    },
  };
}

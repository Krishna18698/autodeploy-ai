import { Valkey } from 'iovalkey';
import postgres from 'postgres';
import type { Env } from './env.js';

export type Deps = {
  sql: postgres.Sql;
  valkey: Valkey;
  close: () => Promise<void>;
};

export function createDeps(env: Env): Deps {
  const sql = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 5,
  });
  const valkey = new Valkey(env.VALKEY_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });

  return {
    sql,
    valkey,
    close: async () => {
      await Promise.allSettled([sql.end({ timeout: 5 }), valkey.quit()]);
    },
  };
}

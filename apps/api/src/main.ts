import { migrate } from '@autodeploy/db';
import { buildApp } from './app.js';
import { createDeps } from './deps.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const deps = createDeps(env);

// Schema first: the migrator holds an advisory lock, so concurrent replicas
// starting together apply migrations exactly once.
if (process.env.MIGRATE_ON_START !== 'false') {
  const r = await migrate(deps.sql);
  if (r.applied.length) console.log(`applied migrations: ${r.applied.join(', ')}`);
}
await deps.storage
  .ensureBucket()
  .catch((err) => console.warn('object storage not reachable yet:', (err as Error).message));

const app = await buildApp(deps);

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then release pools. A second signal forces exit.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await deps.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: env.API_PORT });

import { buildApp } from './app.js';
import { createDeps } from './deps.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const deps = createDeps(env);
const app = await buildApp(env, deps);

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

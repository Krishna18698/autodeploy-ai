import { mkdirSync, writeFileSync } from 'node:fs';

const greeting = process.env.E2E_GREETING;
if (!greeting) {
  console.error('Error: E2E_GREETING is missing. Set it in the project environment.');
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/index.html',
  `<!doctype html><title>e2e env</title><h1>e2e env ok: ${greeting}</h1>`,
);

// Mimics a dependency that requires a newer Node than the repo pins.
import { mkdirSync, writeFileSync } from 'node:fs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(
    `error some-lib@3.0.0: The engine "node" is incompatible with this module. Expected version ">=22". Got "${process.versions.node}"`,
  );
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/index.html',
  `<!doctype html><title>node-engine</title><h1>Built on Node ${process.versions.node}</h1>`,
);

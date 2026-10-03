// Takes ~20 s so chaos tests can break things mid-build.
import { mkdirSync, writeFileSync } from 'node:fs';
for (let i = 1; i <= 20; i++) {
  console.log(`working… ${i}/20`);
  await new Promise((r) => setTimeout(r, 1000));
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><title>slow</title><h1>slow but sure</h1>');

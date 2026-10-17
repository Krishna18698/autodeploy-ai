import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><title>e2e ai</title><h1>e2e ai ok</h1>');

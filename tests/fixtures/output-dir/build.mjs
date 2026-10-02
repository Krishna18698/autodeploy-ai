// Writes to public_html/ instead of the conventional dist/.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('public_html', { recursive: true });
writeFileSync(
  'public_html/index.html',
  '<!doctype html><title>output-dir</title><h1>Found me</h1>',
);

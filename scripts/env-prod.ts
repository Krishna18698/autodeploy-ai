// Reads infra/deploy/.env.prod for the operator scripts. Values are returned,
// never printed; unfilled placeholders count as unset.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLACEHOLDER = /(REPLACE|replace|changeme|CHANGEME|TODO|xxx|XXX|<|your-|YOUR_)/;

export function readEnvProd(): (name: string) => string | undefined {
  const file = resolve(import.meta.dirname, '../infra/deploy/.env.prod');
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) env[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return (name) => {
    const v = env[name];
    return v && !PLACEHOLDER.test(v) ? v : undefined;
  };
}

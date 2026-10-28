import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../apps/api/src/env';

// A setting in .env.prod only reaches a container that the compose file passes
// it to. Google sign-in once shipped with its two values on the VM and neither
// passed to the API, so the button stayed off in production. Every setting the
// API reads is passed to both API containers, or listed here with the reason.
const notPassed: Record<string, string> = {
  DEV_LOGIN: 'local development only (refused in production)',
  ALLOW_LOCAL_SOURCES: 'local development only (refused in production)',
  GITHUB_TOKEN: 'local development without the GitHub App',
  API_PORT: 'the default is what Caddy proxies to',
  LOG_LEVEL: 'the default',
  RATE_LIMIT_PER_MINUTE: 'the default',
  MAX_PROJECTS_PER_ORG: 'the default',
  SSR_PROJECTS_PER_ORG: 'the default',
  STORAGE_MB_PER_ORG: 'the default',
  BUILD_MINUTES_PER_MONTH: 'the default',
};

const compose = await readFile(
  join(__dirname, '../../infra/deploy/docker-compose.prod.yml'),
  'utf8',
);

const keysIn = (block: string) =>
  new Set([...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));

/** The lines of a top-level key (indent 0) or a service (indent 2). */
function block(name: string, indent: 0 | 2): string {
  const lines = compose.split('\n');
  const head = `${' '.repeat(indent)}${name}:`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  if (start < 0) throw new Error(`${name} not in the compose file`);
  const sibling = new RegExp(`^ {0,${indent}}\\S`);
  const end = lines.findIndex((l, i) => i > start && sibling.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

const appEnv = keysIn(block('x-app-env', 0));
const passed = (service: string) => {
  const b = block(service, 2);
  return new Set([...keysIn(b), ...(b.includes('<<: *app-env') ? appEnv : [])]);
};

describe('production settings reach the API', () => {
  const apiReads = Object.keys(EnvSchema.shape);

  it.each(['api-1', 'api-2'])('%s gets every setting the API reads', (svc) => {
    const has = passed(svc);
    expect(apiReads.filter((k) => !has.has(k) && !(k in notPassed))).toEqual([]);
  });

  it('the list of settings left out names only settings the API reads', () => {
    expect(Object.keys(notPassed).filter((k) => !apiReads.includes(k))).toEqual([]);
  });
});

import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { type CiState, ciKeys, ciPartKey } from '@autodeploy/core';
import { encrypt } from '@autodeploy/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GITHUB_OIDC_ISSUER } from '../../apps/api/src/lib/github-oidc';
import { makeDeployment, makeOrg, makeProject } from './helpers';

// Where builds in users' own GitHub Actions report back (ADR 0010), with keys
// of our own standing in for GitHub's and a Map standing in for object storage.

const API = 'https://api.autodeploy.test';
const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...github.publicKey.export({ format: 'jwk' }), kid: 'gh-1' };
const stored = new Map<string, Buffer>();
let app: FastifyInstance;
let deps: Deps;

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_DOMAIN: 'autodeploy.test',
    API_PUBLIC_URL: API,
    DATABASE_URL: inject('databaseUrl'),
    VALKEY_URL: inject('valkeyUrl'),
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
    INTERNAL_TOKEN: 'internal-token-for-tests-123456',
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  (deps as { storage: unknown }).storage = {
    put: async (k: string, body: Buffer) => void stored.set(k, Buffer.from(body)),
  };
  app = await buildApp(deps, { githubKeys: async (kid) => (kid === 'gh-1' ? jwk : null) });
});
afterAll(async () => {
  await app.close();
  await deps.close();
});

let runs = 0;
function jobToken(over: Record<string, unknown> = {}) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'gh-1' });
  const body = b64({
    iss: GITHUB_OIDC_ISSUER,
    aud: API,
    iat: now,
    exp: now + 300,
    repository: 'Acme/CI-Site',
    repository_id: '7',
    workflow_ref: 'Acme/CI-Site/.github/workflows/autodeploy.yml@refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '5001',
    ...over,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(github.privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

/** A project with one variable, a deployment, and a build waiting for GitHub. */
async function waitingBuild(opts: { fromFork?: boolean; maxBytes?: number } = {}) {
  const org = await makeOrg(deps.sql);
  const p = await makeProject(deps.sql, org, {
    repo: 'acme/ci-site',
    slug: `ci-${randomUUID().slice(0, 8)}`,
  });
  const d = await makeDeployment(deps.sql, org, p.id, 'BUILDING', ++runs);
  if (opts.fromFork) await deps.sql`update deployments set from_fork = true where id = ${d}`;
  const sealed = encrypt(deps.keyring, 'super-secret-value', `env:${p.id}:API_KEY`);
  await deps.sql`insert into env_vars (project_id, org_id, key, ciphertext, dek_ciphertext, key_version, preview)
    values (${p.id}, ${org}, 'API_KEY', ${sealed.ciphertext}, ${sealed.dekCiphertext}, ${sealed.keyVersion}, '••••')`;
  const attemptId = randomUUID();
  const state: CiState = {
    nonce: `nonce-${attemptId}`,
    repo: 'acme/ci-site',
    deploymentId: d,
    projectId: p.id,
    orgId: org,
    maxBytes: opts.maxBytes ?? 10_000,
  };
  await deps.valkey.set(ciKeys(attemptId).state, JSON.stringify(state), 'EX', 600);
  const call = (
    method: 'POST' | 'PUT',
    path: string,
    payload?: unknown,
    o: { token?: string; nonce?: string } = {},
  ) =>
    app.inject({
      method,
      url: `/ci/v1/${path}`,
      headers: {
        authorization: `Bearer ${o.token ?? jobToken()}`,
        'x-autodeploy-attempt': attemptId,
        'x-autodeploy-nonce': o.nonce ?? state.nonce,
        'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json',
      },
      payload: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload ?? {}),
    });
  return { attemptId, call };
}

describe("a build in the user's GitHub Actions reporting back", () => {
  it("gets the project's variables, sends its log and output in parts, and finishes once", async () => {
    const { attemptId, call } = await waitingBuild();
    const start = await call('POST', 'start');
    expect(start.statusCode).toBe(200);
    expect(start.json()).toEqual({ env: { API_KEY: 'super-secret-value' } });

    expect(
      (await call('POST', 'log', { lines: ['▸ install', 'added 12 packages'] })).statusCode,
    ).toBe(204);
    expect(await deps.valkey.lrange(ciKeys(attemptId).log, 0, -1)).toEqual([
      '▸ install',
      'added 12 packages',
    ]);

    expect((await call('PUT', 'parts/0', Buffer.from('first part'))).statusCode).toBe(204);
    expect((await call('PUT', 'parts/1', Buffer.from('second'))).statusCode).toBe(204);
    expect(stored.get(ciPartKey(attemptId, 0))?.toString()).toBe('first part');

    expect((await call('POST', 'finish', { exitCode: 0, parts: 2, bytes: 16 })).statusCode).toBe(
      204,
    );
    expect(JSON.parse((await deps.valkey.get(ciKeys(attemptId).done)) ?? '{}')).toEqual({
      exitCode: 0,
      parts: 2,
      bytes: 16,
    });
    const again = await call('POST', 'finish', { exitCode: 1, parts: 0, bytes: 0 });
    expect(again.statusCode).toBe(409); // finished means finished: nothing more is accepted
    expect((await call('PUT', 'parts/2', Buffer.from('late'))).statusCode).toBe(409);
  });

  it("a fork's pull request gets none of the project's variables", async () => {
    const { call } = await waitingBuild({ fromFork: true });
    expect((await call('POST', 'start')).json()).toEqual({ env: {} });
  });

  it.each([
    [
      'another repository',
      { token: jobToken({ repository: 'stranger/ci-site' }) },
      403,
      'another repository',
    ],
    [
      'another workflow file',
      {
        token: jobToken({
          workflow_ref: 'Acme/CI-Site/.github/workflows/evil.yml@refs/heads/main',
        }),
      },
      403,
      'autodeploy.yml',
    ],
    [
      'a run nobody started (a push)',
      { token: jobToken({ event_name: 'push' }) },
      403,
      'Only a run AutoDeploy started',
    ],
    ['the wrong nonce', { nonce: 'guessed' }, 403, 'Wrong nonce'],
    [
      'a token meant for someone else',
      { token: jobToken({ aud: 'https://elsewhere.example' }) },
      403,
      'another audience',
    ],
  ])('refuses %s', async (_why, o, status, message) => {
    const { call } = await waitingBuild();
    const r = await call('POST', 'start', {}, o);
    expect(r.statusCode).toBe(status);
    expect(r.json().detail).toContain(message);
  });

  it('belongs to the first run that claims it; another run is refused', async () => {
    const { call } = await waitingBuild();
    expect((await call('POST', 'start')).statusCode).toBe(200);
    const other = await call(
      'POST',
      'log',
      { lines: ['x'] },
      { token: jobToken({ run_id: '9999' }) },
    );
    expect(other.statusCode).toBe(409);
  });

  it('refuses output bigger than the cap, and an attempt nobody is waiting for', async () => {
    const { call } = await waitingBuild({ maxBytes: 100 });
    expect((await call('PUT', 'parts/0', Buffer.alloc(80))).statusCode).toBe(204);
    const over = await call('PUT', 'parts/1', Buffer.alloc(80));
    expect(over.statusCode).toBe(413);
    const unknown = await app.inject({
      method: 'POST',
      url: '/ci/v1/start',
      headers: {
        authorization: `Bearer ${jobToken()}`,
        'x-autodeploy-attempt': randomUUID(),
        'x-autodeploy-nonce': 'n',
      },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

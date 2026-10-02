import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { parseUnifiedDiff } from '@autodeploy/core';
import { decrypt, hmacSha256Hex } from '@autodeploy/crypto';
import { GitHubClient, parseRepoUrl } from '@autodeploy/github';
import { withTimeout } from '@autodeploy/resilience';
import type { Deps } from '../deps.js';
import { applyPatch } from '../executors/sandbox.js';
import { fetchSource } from '../pipeline/source.js';
import { type JobContext, PermanentError } from '../runner.js';

// ---------------------------------------------------------- outbound webhooks

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** SSRF guard: resolve the host and refuse private/loopback/link-local targets. */
async function assertPublicHost(url: URL, allowLocal: boolean) {
  if (allowLocal) return;
  const addrs = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true });
  for (const a of addrs) {
    const v4 = a.family === 4 && PRIVATE_V4.some((re) => re.test(a.address));
    const v6 =
      a.family === 6 &&
      (a.address === '::1' || /^f[cd]/i.test(a.address) || /^fe80/i.test(a.address));
    if (v4 || v6)
      throw new PermanentError(`refusing to deliver to a private address (${a.address})`);
  }
}

export async function deliverWebhook(deps: Deps, ctx: JobContext): Promise<void> {
  const { deliveryId } = ctx.job.payload as { deliveryId: string };
  const [d] = await deps.sql<
    {
      id: string;
      event_id: string;
      event_type: string;
      payload: unknown;
      attempts: number;
      url: string;
      secret_ciphertext: Buffer;
      secret_dek: Buffer;
      key_version: number;
      endpoint_id: string;
      active: boolean;
    }[]
  >`
    select w.id, w.event_id, w.event_type, w.payload, w.attempts, e.url, e.secret_ciphertext, e.secret_dek, e.key_version, e.id as endpoint_id, e.active
    from webhook_deliveries w join webhook_endpoints e on e.id = w.endpoint_id where w.id = ${deliveryId}`;
  if (!d?.active) return;
  const secret = decrypt(
    deps.keyring,
    { ciphertext: d.secret_ciphertext, dekCiphertext: d.secret_dek, keyVersion: d.key_version },
    `webhook:${d.endpoint_id}`,
  );
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000);
  // Stripe-style: sign "timestamp.body" so receivers can reject replays.
  const signature = `t=${ts},v1=${hmacSha256Hex(secret, `${ts}.${body}`)}`;
  const url = new URL(d.url);
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertPublicHost(url, deps.env.NODE_ENV !== 'production');
    const res = await withTimeout(10_000, (signal) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AutoDeploy-Webhooks/1.0',
          'x-autodeploy-event': d.event_type,
          'x-autodeploy-delivery': d.event_id,
          'x-autodeploy-signature': signature,
        },
        body,
        redirect: 'manual',
        signal,
      }),
    );
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
    if (err instanceof PermanentError) {
      await deps.sql`update webhook_deliveries set status = 'dead', attempts = attempts + 1, last_error = ${error}, updated_at = now() where id = ${d.id}`;
      throw err;
    }
  }
  const ms = Date.now() - started;
  const last = ctx.job.attempts >= ctx.job.maxAttempts;
  await deps.sql`update webhook_deliveries set attempts = attempts + 1, response_status = ${status}, response_ms = ${ms},
    last_error = ${error}, status = ${error ? (last ? 'dead' : 'failed') : 'succeeded'}, updated_at = now() where id = ${d.id}`;
  if (error) throw new Error(`webhook delivery failed: ${error}`); // runner retries with backoff
}

// ------------------------------------------------------- GitHub integration

async function installationClient(
  deps: Deps,
  installationId: number | null,
): Promise<GitHubClient> {
  if (!deps.installations || !installationId)
    throw new PermanentError('GitHub App is not configured for this project');
  const installations = deps.installations;
  return new GitHubClient({ token: () => installations.get(installationId) });
}

export async function commitStatus(deps: Deps, ctx: JobContext): Promise<void> {
  const p = ctx.job.payload as {
    deploymentId: string;
    state: 'pending' | 'success' | 'failure' | 'error';
    description: string;
  };
  const [d] = await deps.sql<
    {
      commit_sha: string | null;
      repo_url: string;
      installation_id: number | null;
      number: number;
    }[]
  >`
    select d.commit_sha, p.repo_url, p.installation_id, d.number from deployments d join projects p on p.id = d.project_id where d.id = ${p.deploymentId}`;
  if (!d?.commit_sha || !d.installation_id || !deps.installations) return; // nothing to report to
  const gh = await installationClient(deps, d.installation_id);
  await gh.createCommitStatus(parseRepoUrl(d.repo_url), d.commit_sha, {
    state: p.state,
    description: p.description,
    targetUrl: `${deps.env.APP_URL}/deployments/${p.deploymentId}`,
  });
}

/** Opens a PR containing an approved AI patch, on a branch; never pushes to main. */
export async function openRepairPr(deps: Deps, ctx: JobContext): Promise<void> {
  const { repairId } = ctx.job.payload as { repairId: string };
  const [r] = await deps.sql<
    {
      diff: string;
      title: string;
      explanation: string;
      deployment_id: string;
      commit_sha: string;
      repo_url: string;
      default_branch: string;
      installation_id: number | null;
      number: number;
      pr_url: string | null;
    }[]
  >`
    select r.diff, r.title, r.explanation, r.deployment_id, d.commit_sha, p.repo_url, p.default_branch, p.installation_id, d.number, r.pr_url
    from repair_attempts r join deployments d on d.id = r.deployment_id join projects p on p.id = d.project_id where r.id = ${repairId}`;
  if (!r || r.pr_url) return;
  const gh = await installationClient(deps, r.installation_id);
  const dir = await mkdtemp(join(deps.env.WORK_DIR, 'pr-'));
  try {
    await fetchSource(deps, r.repo_url, r.commit_sha, dir, r.installation_id);
    const applied = await applyPatch(dir, r.diff);
    if (!applied.ok) throw new PermanentError(`patch no longer applies: ${applied.output}`);
    const files = await Promise.all(
      parseUnifiedDiff(r.diff).map(async (f) => ({
        path: f.path,
        content: await readFile(join(dir, f.path), 'utf8'),
      })),
    );
    const url = await gh.openPullRequest(parseRepoUrl(r.repo_url), {
      base: r.default_branch,
      baseSha: r.commit_sha,
      branch: `autodeploy/fix-${r.number}-${repairId.slice(0, 8)}`,
      title: `fix: ${r.title}`,
      body: `${r.explanation}\n\nProposed by AutoDeploy for deployment #${r.number} and validated in a sandbox build before this PR was opened.`,
      files,
    });
    await deps.sql`update repair_attempts set pr_url = ${url} where id = ${repairId}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

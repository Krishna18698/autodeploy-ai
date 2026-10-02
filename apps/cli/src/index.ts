import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// autodeploy — deploy, follow, roll back from a terminal or CI.
// Exit codes: 0 live/ready · 1 deployment failed · 2 usage/auth/network error.

type Config = { apiUrl: string; token: string };
const CONFIG = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'autodeploy',
  'config.json',
);
const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = (s: string) => c('2', s);
const STATUS_COLOR: Record<string, string> = {
  ACTIVE: '32',
  READY: '32',
  FAILED: '31',
  BUILD_FAILED: '31',
  CANCELED: '2',
  RECOVERING: '33',
  AWAITING_APPROVAL: '35',
  NEEDS_INPUT: '33',
};
const TERMINAL = new Set([
  'ACTIVE',
  'READY',
  'FAILED',
  'CANCELED',
  'NEEDS_INPUT',
  'AWAITING_APPROVAL',
  'SUPERSEDED',
  'ROLLED_BACK',
]);

async function loadConfig(): Promise<Config> {
  const env = process.env.AUTODEPLOY_TOKEN;
  if (env) return { apiUrl: process.env.AUTODEPLOY_API_URL ?? 'http://localhost:4000', token: env };
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8')) as Config;
  } catch {
    fail('Not logged in. Run `autodeploy login --token adp_…` or set AUTODEPLOY_TOKEN.');
  }
}

function fail(msg: string, code = 2): never {
  console.error(c('31', `✗ ${msg}`));
  process.exit(code);
}

async function call<T>(
  cfg: Config,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${cfg.token}`);
  if (init.body) headers.set('content-type', 'application/json');
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}${path}`, { ...init, headers });
  } catch (err) {
    fail(`Cannot reach ${cfg.apiUrl}: ${(err as Error).message}`);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok)
    fail(
      `${body?.detail ?? body?.title ?? res.statusText} (${res.status}${body?.code ? ` ${body.code}` : ''})`,
    );
  return body as T;
}

type Project = {
  id: string;
  slug: string;
  repoFullName: string;
  framework: string;
  url: string;
  activeDeploymentId: string | null;
};
type Deployment = {
  id: string;
  number: number;
  status: string;
  url: string | null;
  errorSummary: string | null;
  projectSlug: string;
  recoveredBy: string | null;
};

async function findProject(cfg: Config, ref: string): Promise<Project> {
  const page = await call<{ items: Project[] }>(cfg, '/api/v1/projects?limit=100');
  const p = page.items.find((x) => x.id === ref || x.slug === ref);
  if (!p) fail(`No project "${ref}". Try \`autodeploy projects\`.`);
  return p;
}

/** Follows the deployment's SSE stream, printing log lines and status changes. */
async function follow(cfg: Config, id: string): Promise<Deployment> {
  const res = await fetch(`${cfg.apiUrl}/api/v1/deployments/${id}/stream`, {
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'text/event-stream' },
  });
  if (!res.ok || !res.body) fail(`stream failed (${res.status})`);
  const decoder = new TextDecoder();
  let buf = '';
  let status = '';
  let kind = 'production';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    for (let idx = buf.indexOf('\n\n'); idx !== -1; idx = buf.indexOf('\n\n')) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'snapshot') {
        status = payload.status;
        kind = payload.kind;
      }
      if (event === 'log')
        for (const l of payload.lines as Array<{ text: string }>) console.log(l.text);
      if (event === 'status' && payload.to) {
        status = payload.to;
        console.log(c(STATUS_COLOR[status] ?? '36', `● ${payload.from ?? ''} → ${status}`));
      }
      // Production isn't done at READY: wait until activation makes it live.
      if (TERMINAL.has(status) && !(status === 'READY' && kind === 'production')) {
        await (res.body as ReadableStream).cancel().catch(() => {});
        return call<Deployment>(cfg, `/api/v1/deployments/${id}`);
      }
    }
  }
  return call<Deployment>(cfg, `/api/v1/deployments/${id}`);
}

function finish(d: Deployment): never {
  const ok = d.status === 'ACTIVE' || d.status === 'READY';
  console.log();
  if (ok) {
    console.log(
      c(
        '32',
        `✓ ${d.projectSlug} #${d.number} is ${d.status === 'ACTIVE' ? 'live' : 'ready'}${d.recoveredBy ? ` (auto-recovered by ${d.recoveredBy})` : ''}`,
      ),
    );
    if (d.url) console.log(`  ${d.url}`);
    process.exit(0);
  }
  if (d.status === 'AWAITING_APPROVAL') {
    console.log(c('35', `⟲ #${d.number} was repaired by AI and needs approval in the dashboard.`));
    process.exit(1);
  }
  console.log(
    c('31', `✗ ${d.projectSlug} #${d.number} ${d.status.toLowerCase()}: ${d.errorSummary ?? ''}`),
  );
  process.exit(1);
}

const program = new Command()
  .name('autodeploy')
  .description('Deploy static sites that fix themselves.')
  .version('1.0.0');

program
  .command('login')
  .description('Store an API token (create one in Settings → API tokens)')
  .requiredOption('--token <token>', 'API token (adp_…)')
  .option('--api <url>', 'API base URL', 'http://localhost:4000')
  .action(async (o: { token: string; api: string }) => {
    const cfg = { apiUrl: o.api.replace(/\/$/, ''), token: o.token };
    const me = await call<{ user: { login: string }; org: { name: string } }>(cfg, '/api/v1/me');
    await mkdir(join(CONFIG, '..'), { recursive: true });
    await writeFile(CONFIG, JSON.stringify(cfg, null, 2));
    await chmod(CONFIG, 0o600);
    console.log(c('32', `✓ logged in as ${me.user.login} (${me.org.name})`), dim(CONFIG));
  });

program
  .command('projects')
  .description('List projects')
  .action(async () => {
    const cfg = await loadConfig();
    const page = await call<{ items: Project[] }>(cfg, '/api/v1/projects?limit=100');
    for (const p of page.items)
      console.log(
        `${p.slug.padEnd(24)} ${dim(p.framework.padEnd(8))} ${p.activeDeploymentId ? p.url : dim('not live')}`,
      );
  });

program
  .command('deploy <project>')
  .description('Deploy a project and follow the build')
  .option('--ref <ref>', 'branch, tag or commit')
  .option('--preview', 'deploy as a preview, not production')
  .option('--no-follow', 'return immediately after queueing')
  .action(async (ref: string, o: { ref?: string; preview?: boolean; follow: boolean }) => {
    const cfg = await loadConfig();
    const p = await findProject(cfg, ref);
    const d = await call<Deployment>(cfg, `/api/v1/projects/${p.id}/deployments`, {
      method: 'POST',
      body: JSON.stringify({
        ...(o.ref && { ref: o.ref }),
        kind: o.preview ? 'preview' : 'production',
      }),
      // Safe to retry the command: the same key never creates two deployments.
      idempotencyKey: `cli-${randomUUID()}`,
    });
    console.log(c('36', `▸ ${p.slug} #${d.number} queued`), dim(d.id));
    if (!o.follow) process.exit(0);
    finish(await follow(cfg, d.id));
  });

program
  .command('logs <deploymentId>')
  .description('Print (or follow) a deployment’s logs')
  .option('-f, --follow', 'stream until the deployment finishes')
  .action(async (id: string, o: { follow?: boolean }) => {
    const cfg = await loadConfig();
    if (o.follow) finish(await follow(cfg, id));
    const r = await call<{ lines: Array<{ text: string; attemptNo: number }> }>(
      cfg,
      `/api/v1/deployments/${id}/logs`,
    );
    for (const l of r.lines) console.log(l.text);
  });

program.command('status <deploymentId>').action(async (id: string) => {
  const cfg = await loadConfig();
  const d = await call<Deployment>(cfg, `/api/v1/deployments/${id}`);
  console.log(
    `${d.projectSlug} #${d.number} ${c(STATUS_COLOR[d.status] ?? '36', d.status)} ${d.url ?? ''}`,
  );
});

program
  .command('rollback <project> <number>')
  .description('Make a previous deployment live again (no rebuild)')
  .action(async (ref: string, num: string) => {
    const cfg = await loadConfig();
    const p = await findProject(cfg, ref);
    const list = await call<{ items: Deployment[] }>(
      cfg,
      `/api/v1/deployments?projectId=${p.id}&limit=100`,
    );
    const target = list.items.find((d) => d.number === Number(num));
    if (!target) fail(`No deployment #${num} in ${p.slug}`);
    const r = await call<{ ms: number }>(cfg, `/api/v1/projects/${p.id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ deploymentId: target.id }),
    });
    console.log(
      c('32', `✓ ${p.slug} is serving #${num} again (${r.ms.toFixed(1)} ms, nothing rebuilt)`),
    );
  });

program.parseAsync().catch((err) => fail((err as Error).message));

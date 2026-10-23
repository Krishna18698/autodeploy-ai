import type { Deps } from './deps.js';

// Webhooks GitHub couldn't deliver while AutoDeploy was down. GitHub sends
// each one once and never retries, so a push made during an outage used to
// never deploy. Every few minutes (and when the worker starts) this asks
// GitHub for the deliveries that failed in the last three days, which is as
// long as GitHub keeps them, and has it send them again, with two rules so an
// outage never costs anyone more than it should:
//   - only the newest per branch, pull request or installation: five pushes
//     made during an outage deploy once, not five times;
//   - only if it is still current: the branch still points at that commit, the
//     pull request at that head. A newer push that did get through wins, and
//     an older commit is never deployed over it.
// Everything passed over is recorded as handled, so it isn't looked at again.

const LOOKBACK_MS = 72 * 3_600_000;
const MAX_ATTEMPTS = 5;
/** Payloads fetched per run (one GitHub call each). */
const MAX_PER_RUN = 50;
const EVENTS = new Set(['push', 'pull_request', 'installation']);

/** One attempt at a delivery, as GitHub lists them (a resend shares the guid). */
export type Attempt = {
  id: number;
  guid: string;
  deliveredAt: string;
  statusCode: number;
  event: string;
};
export type Failed = { id: number; guid: string; event: string; firstAt: string };

export type CatchUpDeps = {
  /** Every attempt GitHub made since `since`, newest first. */
  deliveries(since: Date): Promise<Attempt[]>;
  payload(id: number): Promise<Record<string, unknown>>;
  redeliver(id: number): Promise<void>;
  branchHead(installationId: number, repo: string, branch: string): Promise<string | null>;
  pull(
    installationId: number,
    repo: string,
    n: number,
  ): Promise<{ open: boolean; head: string } | null>;
  installationExists(id: number): Promise<boolean>;
  /** Deliveries the API already took (or this already passed over). */
  handled(guids: string[]): Promise<Set<string>>;
  markHandled(items: Array<{ guid: string; event: string }>): Promise<void>;
  /** A project deploys this repository's `branch` on push (no branch: any project for the repo). */
  watched(repo: string, branch?: string): Promise<boolean>;
  /** The API answers where GitHub sends webhooks (else resending only wastes attempts). */
  apiReady(): Promise<boolean>;
};

// Our API answered (2xx), or refused on purpose (4xx: a bad signature, say).
// Anything else (no answer, Cloudflare's or Caddy's 5xx) was the outage.
const answered = (code: number) => code >= 200 && code < 500;

/** Deliveries that only ever failed because AutoDeploy didn't answer. */
export function failedDeliveries(attempts: Attempt[], handled: Set<string>): Failed[] {
  const byGuid = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (!EVENTS.has(a.event) || handled.has(a.guid)) continue;
    byGuid.set(a.guid, [...(byGuid.get(a.guid) ?? []), a]);
  }
  const out: Failed[] = [];
  for (const [guid, tries] of byGuid) {
    if (tries.some((t) => answered(t.statusCode)) || tries.length >= MAX_ATTEMPTS) continue;
    const first = tries.reduce((a, b) => (a.deliveredAt <= b.deliveredAt ? a : b));
    out.push({ id: first.id, guid, event: first.event, firstAt: first.deliveredAt });
  }
  return out.sort((a, b) => b.firstAt.localeCompare(a.firstAt));
}

type Payload = {
  ref?: string;
  after?: string;
  deleted?: boolean;
  action?: string;
  number?: number;
  pull_request?: { head?: { sha?: string } };
  repository?: { full_name?: string };
  installation?: { id?: number };
};

/** What a delivery is about (newer ones of the same supersede it), and whether it still holds. */
function subject(d: CatchUpDeps, event: string, raw: Record<string, unknown>) {
  const p = raw as Payload;
  const repo = p.repository?.full_name ?? '';
  const inst = p.installation?.id ?? 0;
  if (event === 'push') {
    if (p.deleted || !p.ref?.startsWith('refs/heads/') || !p.after) return null;
    const branch = p.ref.slice('refs/heads/'.length);
    return {
      key: `push:${repo.toLowerCase()}:${branch}`,
      current: async () =>
        (await d.watched(repo, branch)) && (await d.branchHead(inst, repo, branch)) === p.after,
    };
  }
  if (event === 'pull_request' && p.number) {
    const n = p.number;
    const closing = p.action === 'closed';
    if (!closing && !['opened', 'synchronize', 'reopened'].includes(p.action ?? '')) return null;
    return {
      key: `pr:${repo.toLowerCase()}:${n}`,
      current: async () => {
        if (!(await d.watched(repo))) return false;
        const now = await d.pull(inst, repo, n);
        if (!now) return false;
        return closing ? !now.open : now.open && now.head === p.pull_request?.head?.sha;
      },
    };
  }
  if (event === 'installation' && (p.action === 'created' || p.action === 'deleted')) {
    return {
      key: `installation:${inst}`,
      current: async () => (await d.installationExists(inst)) === (p.action === 'created'),
    };
  }
  return null;
}

export async function catchUp(d: CatchUpDeps, now = Date.now()) {
  const done = { redelivered: [] as string[], passedOver: [] as string[] };
  const attempts = await d.deliveries(new Date(now - LOOKBACK_MS));
  if (!attempts.length) return done;
  const failed = failedDeliveries(
    attempts,
    await d.handled([...new Set(attempts.map((a) => a.guid))]),
  );
  if (!failed.length || !(await d.apiReady())) return done;

  // Newest first, so the first of each subject is the one that counts.
  const seen = new Set<string>();
  const passOver: Array<{ guid: string; event: string }> = [];
  for (const f of failed.slice(0, MAX_PER_RUN)) {
    const s = subject(d, f.event, await d.payload(f.id));
    const newest = s && !seen.has(s.key);
    if (s) seen.add(s.key);
    if (!newest || !(await s.current())) {
      passOver.push({ guid: f.guid, event: f.event });
      continue;
    }
    await d.redeliver(f.id);
    done.redelivered.push(f.guid);
  }
  if (passOver.length) await d.markHandled(passOver);
  done.passedOver = passOver.map((p) => p.guid);
  return done;
}

// ---- wired to GitHub and the database

type ListedDelivery = {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number;
  event: string;
};

export async function catchUpWebhooks(deps: Deps) {
  const gh = deps.installations;
  if (!gh) return;
  const ok = async (r: Response) => {
    if (!r.ok) throw new Error(`GitHub ${r.status} ${r.url}`);
    return r;
  };
  const result = await catchUp({
    async deliveries(since) {
      const out: Attempt[] = [];
      let path: string | null = '/app/hook/deliveries?per_page=100';
      for (let page = 0; path && page < 20; page++) {
        const r: Response = await ok(await gh.asApp(path));
        const rows = (await r.json()) as ListedDelivery[];
        for (const x of rows)
          out.push({
            id: x.id,
            guid: x.guid,
            deliveredAt: x.delivered_at,
            statusCode: x.status_code,
            event: x.event,
          });
        const last = rows.at(-1);
        const next = /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/.exec(
          r.headers.get('link') ?? '',
        );
        path =
          last && Date.parse(last.delivered_at) > since.getTime() && next
            ? (next[1] ?? null)
            : null;
      }
      return out.filter((a) => Date.parse(a.deliveredAt) > since.getTime());
    },
    async payload(id) {
      const r = await ok(await gh.asApp(`/app/hook/deliveries/${id}`));
      return (
        ((await r.json()) as { request?: { payload?: Record<string, unknown> } }).request
          ?.payload ?? {}
      );
    },
    async redeliver(id) {
      await ok(await gh.asApp(`/app/hook/deliveries/${id}/attempts`, { method: 'POST' }));
    },
    async branchHead(inst, repo, branch) {
      const r = await gh.asInstallation(
        inst,
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      if (r.status === 404) return null;
      return ((await (await ok(r)).json()) as { object: { sha: string } }).object.sha;
    },
    async pull(inst, repo, n) {
      const r = await gh.asInstallation(inst, `/repos/${repo}/pulls/${n}`);
      if (r.status === 404) return null;
      const p = (await (await ok(r)).json()) as { state: string; head: { sha: string } };
      return { open: p.state === 'open', head: p.head.sha };
    },
    async installationExists(id) {
      const r = await gh.asApp(`/app/installations/${id}`);
      if (r.status === 404) return false;
      await ok(r);
      return true;
    },
    async handled(guids) {
      const rows = await deps.sql<{ delivery_id: string }[]>`
        select delivery_id from github_deliveries where delivery_id = any(${guids})`;
      return new Set(rows.map((r) => r.delivery_id));
    },
    async markHandled(items) {
      for (const i of items)
        await deps.sql`insert into github_deliveries (delivery_id, event)
          values (${i.guid}, ${i.event}) on conflict do nothing`;
    },
    async watched(repo, branch) {
      const rows = await deps.sql`
        select 1 from projects where lower(repo_full_name) = lower(${repo})
          and taken_down_at is null ${branch === undefined ? deps.sql`` : deps.sql`and default_branch = ${branch}`}
        limit 1`;
      return rows.length > 0;
    },
    async apiReady() {
      try {
        const r = await fetch(`${deps.env.API_PUBLIC_URL}/readyz`, {
          signal: AbortSignal.timeout(5_000),
        });
        return r.ok;
      } catch {
        return false;
      }
    },
  });
  if (result.redelivered.length || result.passedOver.length)
    deps.log.info(result, 'caught up on webhooks GitHub could not deliver');
}

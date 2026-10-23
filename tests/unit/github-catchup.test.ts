import { describe, expect, it } from 'vitest';
import {
  type Attempt,
  type CatchUpDeps,
  catchUp,
  failedDeliveries,
} from '../../apps/worker/src/github-catchup';

// Webhooks GitHub couldn't deliver during an outage are resent afterwards:
// only the newest per branch / pull request, and only while still current.

const now = Date.parse('2026-10-23T12:00:00Z');
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
let ids = 0;
const attempt = (guid: string, minAgo: number, statusCode: number, event = 'push'): Attempt => ({
  id: ++ids,
  guid,
  deliveredAt: at(minAgo),
  statusCode,
  event,
});
const push = (after: string, branch = 'main', repo = 'acme/shop') => ({
  ref: `refs/heads/${branch}`,
  after,
  repository: { full_name: repo },
  installation: { id: 7 },
});

/** A fake GitHub + database: payloads by attempt id, current branch heads by "repo:branch". */
function world(o: {
  attempts: Attempt[];
  payloads: Record<number, Record<string, unknown>>;
  heads?: Record<string, string>;
  pulls?: Record<string, { open: boolean; head: string }>;
  handled?: string[];
  apiReady?: boolean;
}) {
  const handled = new Set(o.handled ?? []);
  const redelivered: number[] = [];
  const d: CatchUpDeps = {
    deliveries: async () => o.attempts,
    payload: async (id) => o.payloads[id] ?? {},
    redeliver: async (id) => {
      redelivered.push(id);
    },
    branchHead: async (_i, repo, branch) => o.heads?.[`${repo}:${branch}`] ?? null,
    pull: async (_i, repo, n) => o.pulls?.[`${repo}#${n}`] ?? null,
    installationExists: async () => true,
    handled: async () => handled,
    markHandled: async (items) => {
      for (const i of items) handled.add(i.guid);
    },
    watched: async (repo, branch) => repo === 'acme/shop' && (branch ?? 'main') === 'main',
    apiReady: async () => o.apiReady ?? true,
  };
  return { d, redelivered, handled };
}

describe('which deliveries count as missed', () => {
  it('only ones that never got an answer from us, and not after five tries', () => {
    const list = [
      attempt('ok', 30, 202),
      attempt('refused', 30, 403), // bad signature: refused on purpose, never resent
      attempt('down', 30, 530),
      attempt('timeout', 30, 0),
      ...[1, 2, 3, 4, 5].map((i) => attempt('hopeless', 30 + i, 502)),
      attempt('star', 30, 502, 'star'), // an event nothing here acts on
      attempt('seen', 30, 502),
    ];
    const got = failedDeliveries(list, new Set(['seen'])).map((f) => f.guid);
    expect(got.sort()).toEqual(['down', 'timeout']);
  });

  it('a resend that got through makes the whole delivery done', () => {
    const list = [attempt('a', 60, 530), attempt('a', 5, 202)];
    expect(failedDeliveries(list, new Set())).toEqual([]);
  });
});

describe('catching up after an outage', () => {
  it('five pushes during an outage deploy once: the newest, still the branch head', async () => {
    const attempts = [1, 2, 3, 4, 5].map((i) => attempt(`p${i}`, 60 - i * 5, 530));
    const payloads = Object.fromEntries(attempts.map((a, i) => [a.id, push(`sha${i + 1}`)]));
    const w = world({ attempts, payloads, heads: { 'acme/shop:main': 'sha5' } });
    const r = await catchUp(w.d, now);
    expect(r.redelivered).toEqual(['p5']);
    expect(w.redelivered).toEqual([attempts[4]?.id]);
    // The older four are recorded as handled, so they're never resent later.
    expect([...w.handled].sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('never deploys an older commit over a newer push that got through', async () => {
    const missed = attempt('old', 90, 530);
    const w = world({
      attempts: [missed],
      payloads: { [missed.id]: push('sha-old') },
      heads: { 'acme/shop:main': 'sha-new' }, // pushed after the outage, deployed normally
    });
    const r = await catchUp(w.d, now);
    expect(r.redelivered).toEqual([]);
    expect(r.passedOver).toEqual(['old']);
  });

  it('branches and repositories nobody deploys from are passed over', async () => {
    const a = attempt('feature', 20, 530);
    const b = attempt('other-repo', 20, 530);
    const w = world({
      attempts: [a, b],
      payloads: { [a.id]: push('f1', 'feature'), [b.id]: push('x1', 'main', 'acme/other') },
      heads: { 'acme/shop:feature': 'f1', 'acme/other:main': 'x1' },
    });
    expect((await catchUp(w.d, now)).redelivered).toEqual([]);
  });

  it('a pull request gets its preview only if that head is still the latest, and closes stay closed', async () => {
    const opened = attempt('pr-sync', 30, 530, 'pull_request');
    const stale = attempt('pr-old', 40, 530, 'pull_request');
    const closed = attempt('pr-closed', 30, 530, 'pull_request');
    const pr = (n: number, action: string, sha: string) => ({
      action,
      number: n,
      pull_request: { head: { sha } },
      repository: { full_name: 'acme/shop' },
      installation: { id: 7 },
    });
    const w = world({
      attempts: [opened, stale, closed],
      payloads: {
        [opened.id]: pr(4, 'synchronize', 'h2'),
        [stale.id]: pr(4, 'opened', 'h1'),
        [closed.id]: pr(9, 'closed', 'z'),
      },
      pulls: {
        'acme/shop#4': { open: true, head: 'h2' },
        'acme/shop#9': { open: false, head: 'z' },
      },
    });
    const r = await catchUp(w.d, now);
    expect(r.redelivered.sort()).toEqual(['pr-closed', 'pr-sync']);
    expect(r.passedOver).toEqual(['pr-old']);
  });

  it('waits while the API still is not answering, spending none of the tries', async () => {
    const a = attempt('p', 10, 530);
    const w = world({
      attempts: [a],
      payloads: { [a.id]: push('s') },
      heads: { 'acme/shop:main': 's' },
      apiReady: false,
    });
    const r = await catchUp(w.d, now);
    expect(r).toEqual({ redelivered: [], passedOver: [] });
    expect(w.redelivered).toEqual([]);
  });
});

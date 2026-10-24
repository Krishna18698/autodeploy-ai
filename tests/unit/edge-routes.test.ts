import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, resolveRoute } from '../../apps/edge/src/index';

// 2026-10-24: a load test sent every site visit to Workers KV, used up its
// 100,000 free reads for the day, and every KV read then failed: every site
// answered 500 until midnight UTC. Now the edge cache answers first, and the
// origin answers when KV can't.

const live = { deploymentId: 'd1', number: 3, artifactSha: 'abc', projectSlug: 'shop' };
const route = { kind: 'production', slug: 'shop' } as const;

function setup(kv: () => Promise<unknown>) {
  const store = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void store.set(req.url, res),
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const get = vi.fn(kv);
  const env = {
    ROUTE_MODE: 'kv',
    ROUTES: { get },
    API_URL: 'https://api.example',
    INTERNAL_TOKEN: 'internal-token',
  } as unknown as Env;
  const lookup = async () => {
    const r = await resolveRoute(env, 'shop.sites.example', route, ctx, cache as unknown as Cache);
    await Promise.all(pending);
    return r;
  };
  return { lookup, get, env, ctx, cache };
}
function origin(status: number, body?: unknown) {
  const f = vi.fn(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe('which deployment an address serves', () => {
  it('when KV fails, asks the origin, and keeps its answer in the edge cache', async () => {
    const fetch = origin(200, live);
    const { lookup, get } = setup(async () => {
      throw new Error('KV GET failed: 429 Too Many Requests');
    });
    expect(await lookup()).toEqual(live);
    expect(fetch).toHaveBeenCalledWith('https://api.example/internal/routes/shop.sites.example', {
      headers: { 'x-internal-token': 'internal-token' },
    });
    expect(await lookup()).toEqual(live); // from the edge cache: neither KV nor the origin again
    expect(get).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads KV once per address while the edge cache holds it, and never asks the origin', async () => {
    const fetch = origin(500);
    const { lookup, get } = setup(async () => live);
    for (let i = 0; i < 50; i++) expect(await lookup()).toEqual(live);
    expect(get).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers "nothing here" too, and a takedown', async () => {
    origin(500);
    const none = setup(async () => null);
    expect(await none.lookup()).toBeNull();
    expect(await none.lookup()).toBeNull();
    expect(none.get).toHaveBeenCalledTimes(1);
    const down = setup(async () => ({ takenDown: true }));
    expect(await down.lookup()).toEqual({ takenDown: true });
  });

  it("with KV down: the origin's 404 is 'nothing here'; its failure is an error, never a wrong answer", async () => {
    const failing = async () => {
      throw new Error('KV down');
    };
    origin(404);
    expect(await setup(failing).lookup()).toBeNull();
    origin(503);
    await expect(setup(failing).lookup()).rejects.toThrow('origin route lookup failed: 503');
  });
});

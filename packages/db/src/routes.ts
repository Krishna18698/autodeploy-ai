// The edge resolves "hostname → artifact" through a route store. Postgres is
// always the source of truth; in production the routes are mirrored to
// Cloudflare KV so the edge never has to call back into the origin.

export type RouteValue = {
  deploymentId: string;
  number: number;
  artifactSha: string;
  projectSlug: string;
  /** 'ssr': anything not in the static artifact is proxied to the runtime gateway. */
  mode?: 'ssr';
};

/**
 * The edge route for a deployment. Every writer goes through this: a
 * server-rendered deployment written without its mode is served as a static
 * site, which has no index.html, so every page 404s.
 */
export function routeValue(d: {
  deploymentId: string;
  number: number;
  artifactSha: string;
  projectSlug: string;
  mode?: 'static' | 'ssr' | null;
}): RouteValue {
  return {
    deploymentId: d.deploymentId,
    number: d.number,
    artifactSha: d.artifactSha,
    projectSlug: d.projectSlug,
    ...(d.mode === 'ssr' && { mode: 'ssr' as const }),
  };
}

/** What a taken-down site's addresses hold: the edge answers with a notice. */
export const TAKEN_DOWN = { takenDown: true } as const;
export type TakenDown = typeof TAKEN_DOWN;

export interface RouteStore {
  readonly name: string;
  put(key: string, value: RouteValue | TakenDown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Local/dev: the edge asks the API, which reads Postgres. Nothing to mirror. */
export class PostgresRouteStore implements RouteStore {
  readonly name = 'postgres';
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

export class CloudflareKvRouteStore implements RouteStore {
  readonly name = 'cloudflare-kv';
  constructor(private readonly o: { accountId: string; namespaceId: string; apiToken: string }) {}

  private url(key: string) {
    return `https://api.cloudflare.com/client/v4/accounts/${this.o.accountId}/storage/kv/namespaces/${this.o.namespaceId}/values/${encodeURIComponent(key)}`;
  }

  async put(key: string, value: RouteValue | TakenDown): Promise<void> {
    const res = await fetch(this.url(key), {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.o.apiToken}`, 'content-type': 'text/plain' },
      body: JSON.stringify(value),
    });
    if (!res.ok)
      throw new Error(`KV put ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.o.apiToken}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`KV delete ${key} failed: ${res.status}`);
  }
}

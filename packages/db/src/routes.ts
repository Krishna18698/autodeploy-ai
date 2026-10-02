// The edge resolves "hostname → artifact" through a route store. Postgres is
// always the source of truth; in production the routes are mirrored to
// Cloudflare KV so the edge never has to call back into the origin.

export type RouteValue = {
  deploymentId: string;
  number: number;
  artifactSha: string;
  projectSlug: string;
};

export interface RouteStore {
  readonly name: string;
  put(key: string, value: RouteValue): Promise<void>;
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

  async put(key: string, value: RouteValue): Promise<void> {
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

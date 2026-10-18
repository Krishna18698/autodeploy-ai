import type { Deps } from './deps.js';

// Build logs, screenshots and server bundles live in object storage, keyed by
// the attempt, deployment or bundle they belong to. Once nothing in the
// database refers to one (its project or account was deleted, or its
// deployment was pruned), it is deleted: what the privacy policy promises, and
// what keeps the 10 GB of free storage from filling up.

export type StoredObject = { key: string; modified: Date };

/** The kinds of object swept, and how to tell which database row owns one. */
export const SWEPT = [
  {
    prefix: 'logs/',
    owner: (key: string) => /^logs\/([0-9a-f-]{36})\//.exec(key)?.[1] ?? null,
    table: 'deployment_attempts',
  },
  {
    prefix: 'screenshots/',
    owner: (key: string) => /^screenshots\/([0-9a-f-]{36})\.png$/.exec(key)?.[1] ?? null,
    table: 'deployments',
  },
  {
    prefix: 'runtimes/',
    owner: (key: string) => /^runtimes\/([0-9a-f]{64})\.tar\.gz$/.exec(key)?.[1] ?? null,
    table: 'runtime_sha',
  },
] as const;

/**
 * Keys no live row owns, older than the grace period (a new upload is written
 * before the row that records it). Keys we can't attribute are left alone.
 */
export function unreferenced(
  objects: readonly StoredObject[],
  owner: (key: string) => string | null,
  live: ReadonlySet<string>,
  now: number,
  graceMs: number,
): string[] {
  return objects
    .filter((o) => {
      const id = owner(o.key);
      return id !== null && !live.has(id) && now - o.modified.getTime() > graceMs;
    })
    .map((o) => o.key);
}

export async function sweepStorage(deps: Deps, graceMs = 24 * 3_600_000): Promise<void> {
  for (const kind of SWEPT) {
    const objects = await deps.storage.listObjects(kind.prefix);
    const ids = [...new Set(objects.map((o) => kind.owner(o.key)).filter((x): x is string => !!x))];
    if (ids.length === 0) continue;
    const rows =
      kind.table === 'runtime_sha'
        ? await deps.sql<{ id: string }[]>`
            select distinct runtime_sha as id from deployments where runtime_sha = any(${ids})`
        : kind.table === 'deployments'
          ? await deps.sql<{ id: string }[]>`
              select id::text as id from deployments where id = any(${ids}::uuid[])`
          : await deps.sql<{ id: string }[]>`
              select id::text as id from deployment_attempts where id = any(${ids}::uuid[])`;
    const victims = unreferenced(
      objects,
      kind.owner,
      new Set(rows.map((r) => r.id)),
      Date.now(),
      graceMs,
    );
    if (victims.length === 0) continue;
    await deps.storage.deleteKeys(victims);
    deps.log.info({ prefix: kind.prefix, deleted: victims.length }, 'swept unreferenced objects');
  }
}

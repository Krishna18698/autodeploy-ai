import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { walk } from '@autodeploy/storage';
import type { Deps } from '../deps.js';

const HASHED_ASSET =
  /(^|\/)(assets|_next\/static|_astro)\/|[.-][0-9a-f]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp|avif)$/i;
export const MAX_SITE_BYTES = 250 * 1024 * 1024;
export const MAX_SITE_FILES = 20_000;

async function fileHash(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export type ArtifactInfo = {
  id: string;
  sha256: string;
  fileCount: number;
  bytes: number;
  reused: boolean;
};

/**
 * Content-addresses the build output: the artifact id is the sha256 of a
 * sorted manifest of (path, file hash, size). Rebuilding identical output —
 * a rollback, a redeploy, a no-op commit — uploads nothing new.
 */
export async function storeArtifact(deps: Deps, dir: string): Promise<ArtifactInfo> {
  const entries: Array<{ path: string; hash: string; size: number }> = [];
  let bytes = 0;
  for await (const f of walk(dir)) {
    const rel = relative(dir, f).split(sep).join('/');
    const size = (await stat(f)).size;
    bytes += size;
    if (bytes > MAX_SITE_BYTES)
      throw new Error(`site output exceeds ${MAX_SITE_BYTES / 1024 / 1024} MB`);
    entries.push({ path: rel, hash: await fileHash(f), size });
    if (entries.length > MAX_SITE_FILES)
      throw new Error(`site output exceeds ${MAX_SITE_FILES} files`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = entries.map((e) => `${e.path}\t${e.hash}\t${e.size}`).join('\n');
  const sha256 = createHash('sha256').update(manifest).digest('hex');

  const [existing] = await deps.sql<
    { id: string }[]
  >`select id from artifacts where sha256 = ${sha256}`;
  if (existing) return { id: existing.id, sha256, fileCount: entries.length, bytes, reused: true };

  const prefix = `sites/${sha256}`;
  await deps.storage.uploadDir(dir, prefix, (rel) =>
    HASHED_ASSET.test(rel)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  );
  await deps.storage.put(
    `${prefix}/.autodeploy-manifest.tsv`,
    manifest,
    'text/tab-separated-values',
  );
  const [row] = await deps.sql<{ id: string }[]>`
    insert into artifacts (sha256, storage_prefix, file_count, bytes) values (${sha256}, ${prefix}, ${entries.length}, ${bytes})
    on conflict (sha256) do update set sha256 = excluded.sha256 returning id`;
  if (!row) throw new Error('artifact insert failed');
  return { id: row.id, sha256, fileCount: entries.length, bytes, reused: false };
}

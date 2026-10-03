import type { FileTree } from '@autodeploy/core';

/** In-memory FileTree for analyzer tests. */
export function tree(files: Record<string, string | object>): FileTree {
  const map = new Map(
    Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  return { files: [...map.keys()].sort(), read: (p) => map.get(p) };
}

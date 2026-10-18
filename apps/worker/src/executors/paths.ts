import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(rel: string) {
    super(`"${rel}" points outside the repository`);
    this.name = 'PathEscapeError';
  }
}

/**
 * `rel` under `base`, refusing anything that ends up outside it: "../", an
 * absolute path, or a symlink (a repository or a build can create one) out of
 * the checkout. A project's root and output directories are user input, and
 * host files must never reach an artifact or an AI prompt.
 */
export async function inside(base: string, rel: string | null | undefined): Promise<string> {
  const root = await realpath(base);
  const target = resolve(root, rel && rel !== '.' ? rel : '.');
  const real = await realpath(target).catch(() => target); // may not exist yet
  for (const p of [target, real])
    if (p !== root && !p.startsWith(root + sep)) throw new PathEscapeError(String(rel));
  return real;
}

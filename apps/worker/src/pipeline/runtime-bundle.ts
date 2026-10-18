import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerSpec } from '@autodeploy/core';
import type { Deps } from '../deps.js';
import { inside } from '../executors/paths.js';

// A server-rendered (Next.js standalone) build becomes two things (ADR 0008):
//  - assets: /_next/static/* and public/*, published as a normal static
//    artifact so the edge serves them without waking the server;
//  - bundle: server.js + traced node_modules + .next/static + public, stored as
//    runtimes/<sha256>.tar.gz and started on demand by the gateway.

export type SsrOutput = { bundleDir: string; assetsDir: string };

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

export async function assembleSsr(
  serverDir: string,
  projectRoot: string,
  distDir: string,
  outDir: string,
): Promise<SsrOutput> {
  const bundleDir = join(outDir, 'bundle');
  const assetsDir = join(outDir, 'assets');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });
  // Symlinks inside standalone node_modules (pnpm) are relative; keep them as links.
  await cp(serverDir, bundleDir, { recursive: true, verbatimSymlinks: true });
  const staticSrc = join(projectRoot, distDir, 'static');
  if (await exists(staticSrc)) {
    await cp(staticSrc, join(bundleDir, distDir, 'static'), { recursive: true });
    await cp(staticSrc, join(assetsDir, '_next', 'static'), { recursive: true });
  }
  const publicSrc = join(projectRoot, 'public');
  if (await exists(publicSrc)) {
    await cp(publicSrc, join(bundleDir, 'public'), { recursive: true });
    await cp(publicSrc, assetsDir, { recursive: true });
  }
  // The runtime's root filesystem is read-only; Next's cache gets a tmpfs here.
  await mkdir(join(bundleDir, distDir, 'cache'), { recursive: true });
  return { bundleDir, assetsDir };
}

/**
 * Any other server (Nuxt, SvelteKit, Astro, Remix, a plain Node app): the bundle
 * is used where it lies (an output directory, or the whole built checkout so
 * node_modules and workspace packages come along); the framework's static
 * files are copied out for the edge. `workdir` is where the start command runs.
 */
export async function assembleServer(
  server: ServerSpec,
  projectRoot: string,
  bundleDir: string,
  rootDir: string,
  outDir: string,
): Promise<SsrOutput & { workdir: string }> {
  const assetsDir = join(outDir, 'assets');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });
  if (server.assets) {
    const src = await inside(projectRoot, server.assets).catch(() => null);
    if (src && (await exists(src)))
      await cp(src, assetsDir, { recursive: true, verbatimSymlinks: true });
  }
  const workdir =
    server.bundle === 'project' && rootDir && rootDir !== '.'
      ? rootDir.replace(/^\.\//, '').replace(/\/+$/, '')
      : '.';
  return { bundleDir, assetsDir, workdir };
}

/** Left out of non-Next bundles: history and caches, never needed to run. */
export const BUNDLE_EXCLUDES = ['.git', '.cache', '.turbo', 'node_modules/.cache', '.next/cache'];

function tarGz(dir: string, file: string, excludes: readonly string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-czf', file, ...excludes.map((e) => `--exclude=${e}`), '-C', dir, '.'];
    const p = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim()}`))));
  });
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

export const runtimeKey = (sha: string) => `runtimes/${sha}.tar.gz`;

export type PackedBundle = { file: string; sha256: string; bytes: number };

/** Packs the pristine bundle (before validation runs it and writes caches). */
export async function packRuntimeBundle(
  bundleDir: string,
  opts: { file?: string; excludes?: readonly string[] } = {},
): Promise<PackedBundle> {
  const file = opts.file ?? `${bundleDir}.tar.gz`;
  await tarGz(bundleDir, file, opts.excludes);
  return { file, sha256: await sha256File(file), bytes: (await stat(file)).size };
}

/** Uploads a packed bundle; identical bundles are stored once. */
export async function uploadRuntimeBundle(deps: Deps, b: PackedBundle): Promise<boolean> {
  const key = runtimeKey(b.sha256);
  if (await deps.storage.exists(key)) return true;
  // A Buffer, not a stream: S3-compatible stores (B2) want a known length.
  await deps.storage.put(key, await readFile(b.file), 'application/gzip');
  return false;
}

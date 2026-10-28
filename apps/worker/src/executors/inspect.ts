import { access, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { type BuildConfig, NEXT_SERVER } from '@autodeploy/core';
import type { LogSink } from '../pipeline/logs.js';
import { inside, PathEscapeError } from './paths.js';
import type { ExecuteResult } from './types.js';

/**
 * After a successful install and build, wherever it ran (the sandbox, or the
 * user's GitHub Actions with its output unpacked into the checkout): finds what
 * the build produced, refusing anything outside the checkout.
 */
export async function inspectBuild(
  { srcDir, config, log }: { srcDir: string; config: BuildConfig; log: Pick<LogSink, 'write'> },
  exitCode: number | null,
  durationMs: number,
): Promise<ExecuteResult> {
  const server = config.mode === 'ssr' ? (config.server ?? NEXT_SERVER) : null;
  // Resolved on the host after the build ran: refuse anything outside the checkout.
  let projectRoot: string;
  let outputDir: string;
  try {
    projectRoot = await inside(srcDir, config.rootDir);
    outputDir = await inside(srcDir, posix.join(config.rootDir || '.', config.outputDir));
  } catch (err) {
    if (!(err instanceof PathEscapeError)) throw err;
    log.write(`autodeploy: ${err.message}; nothing was published`);
    return { ok: false, exitCode, reason: 'failed', durationMs, indexDirs: [] };
  }
  if (server && server.bundle !== 'next-standalone') {
    // Other servers: a self-contained output directory (Nuxt's .output) or the
    // built checkout itself becomes the runtime bundle.
    const bundleDir =
      server.bundle === 'output-dir'
        ? await inside(projectRoot, server.dir ?? '.output').catch(() => null)
        : srcDir;
    const exists = bundleDir
      ? await access(bundleDir).then(
          () => true,
          () => false,
        )
      : false;
    if (!bundleDir || !exists) {
      log.write(`autodeploy: the build did not produce ${server.dir ?? 'its server'}`);
      return { ok: false, exitCode, reason: 'output_missing', durationMs, indexDirs: [] };
    }
    return { ok: true, outputDir: projectRoot, durationMs, projectRoot, bundleDir };
  }
  if (server) {
    const standalone = await inside(outputDir, 'standalone').catch(() => null);
    const serverDir = standalone ? await findStandaloneServer(standalone) : null;
    if (!serverDir) {
      log.write(
        `autodeploy: the build did not produce a standalone server (${config.outputDir}/standalone/server.js)`,
      );
      return { ok: false, exitCode, reason: 'output_missing', durationMs, indexDirs: [] };
    }
    return { ok: true, outputDir, durationMs, serverDir, projectRoot };
  }
  const hasIndex = await access(join(outputDir, 'index.html')).then(
    () => true,
    () => false,
  );
  if (!hasIndex) {
    const indexDirs = await findIndexDirs(projectRoot);
    const exists = await access(outputDir).then(
      () => true,
      () => false,
    );
    log.write(
      exists
        ? `autodeploy: output directory "${config.outputDir}" has no index.html`
        : `autodeploy: output directory "${config.outputDir}" was not produced`,
    );
    return { ok: false, exitCode, reason: 'output_missing', durationMs, indexDirs };
  }
  return { ok: true, outputDir, durationMs };
}

export async function findIndexDirs(root: string, depth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, d: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'index.html')) {
      const rel = relative(root, dir).split(sep).join('/');
      out.push(rel === '' ? '.' : rel);
    }
    if (d === 0) return;
    for (const e of entries) {
      if (e.isDirectory() && !['node_modules', '.git', 'src', '.cache'].includes(e.name))
        await walk(join(dir, e.name), d - 1);
    }
  };
  await walk(root, depth);
  return out;
}

/**
 * Where server.js landed inside .next/standalone. It's at the top unless the
 * app sits in a monorepo (Next mirrors the path from the tracing root).
 */
export async function findStandaloneServer(standalone: string, depth = 4): Promise<string | null> {
  const has = await access(join(standalone, 'server.js')).then(
    () => true,
    () => false,
  );
  if (has) return standalone;
  if (depth === 0) return null;
  const entries = await readdir(standalone, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const found = await findStandaloneServer(join(standalone, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

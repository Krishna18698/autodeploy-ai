import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Env } from '../env.js';
import { proxyByAddress } from './proxy-address.js';
import type { ExecuteInput, ExecuteResult, Executor } from './types.js';

// Runs untrusted `install && build` in a locked-down container:
//   - gVisor (runsc) in production: syscalls hit a user-space kernel, not the host's
//   - read-only root filesystem, tmpfs /tmp, writable workspace only
//   - all capabilities dropped, no-new-privileges, non-root user
//   - CPU, memory and PID limits; a hard wall-clock timeout
//   - no direct network: the sandbox network is `internal`, and the only way
//     out is an allowlisting HTTP(S) proxy (npm/yarn registries, GitHub codeload)

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function buildScript(
  installCommand: string | null,
  buildCommand: string | null,
  rootDir: string,
): string {
  const cd = rootDir && rootDir !== '.' ? `cd ${sh(rootDir)}\n` : '';
  const step = (label: string, cmd: string) => `echo ${sh(`▸ ${label}: ${cmd}`)}\n${cmd}\n`;
  // The image bakes common pnpm/yarn versions into a read-only /opt/corepack.
  // A project pinning another version (packageManager: pnpm@10.21.0) makes
  // corepack download it, so give it a writable home seeded with the baked ones.
  const corepack =
    'mkdir -p /tmp/corepack && cp -R /opt/corepack/. /tmp/corepack/ 2>/dev/null || true\n';
  return `set -e\n${corepack}${cd}echo "▸ node $(node --version) on $(uname -m)"\n${installCommand ? step('install', installCommand) : ''}${buildCommand ? step('build', buildCommand) : ''}`;
}

function run(
  cmd: string,
  args: string[],
  onLine?: (l: string) => void,
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (onLine) {
      createInterface({ input: child.stdout }).on('line', onLine);
      createInterface({ input: child.stderr }).on('line', onLine);
    }
    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(code);
    });
  });
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

export class SandboxExecutor implements Executor {
  readonly name = 'sandbox' as const;
  constructor(private readonly env: Env) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const { config, log, signal } = input;
    const started = Date.now();
    const name = `ad-build-${input.attemptId}`;
    const proxy =
      this.env.SANDBOX_RUNTIME === 'runsc'
        ? await proxyByAddress(this.env.SANDBOX_PROXY, this.env.SANDBOX_NETWORK)
        : this.env.SANDBOX_PROXY;
    const env: Record<string, string> = {
      ...input.secrets,
      ...config.env,
      CI: '1',
      HOME: '/tmp/home',
      npm_config_cache: '/tmp/npm-cache',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_proxy: proxy,
      npm_config_https_proxy: proxy,
      YARN_HTTP_PROXY: proxy,
      YARN_HTTPS_PROXY: proxy,
      YARN_ENABLE_TELEMETRY: '0',
      COREPACK_ENABLE_STRICT: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      // The image's corepack home is read-only; the script seeds this copy.
      COREPACK_HOME: '/tmp/corepack',
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      // Node's built-in fetch ignores proxy variables unless told otherwise.
      NODE_USE_ENV_PROXY: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      ASTRO_TELEMETRY_DISABLED: '1',
    };
    // That proxy switch makes Node print an "experimental" warning on every
    // process; it is ours, not the user's, so keep it out of their logs.
    // (--disable-warning needs Node 20.11+; Node 18 builds keep the warning.)
    // Server builds: Next's own switch for standalone output, so the user's
    // next.config is never edited (ADR 0008).
    if (config.mode === 'ssr') env.NEXT_PRIVATE_STANDALONE = '1';
    if (config.nodeVersion >= 20) {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA']
        .filter(Boolean)
        .join(' ');
    }
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const image = `${this.env.SANDBOX_IMAGE_PREFIX}${config.nodeVersion}`;
    if ((await run('docker', ['image', 'inspect', image])) !== 0) {
      // An operator problem, not the user's: say so plainly and don't guess at a fix.
      log.write(
        `autodeploy: no build image for Node ${config.nodeVersion} on this worker (${image}); this is a platform issue`,
      );
      return {
        ok: false,
        exitCode: null,
        reason: 'failed',
        durationMs: Date.now() - started,
        indexDirs: [],
      };
    }
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      ...(this.env.SANDBOX_RUNTIME === 'runsc' ? ['--runtime=runsc'] : []),
      '--network',
      this.env.SANDBOX_NETWORK,
      '--cpus',
      this.env.SANDBOX_CPUS,
      '--memory',
      this.env.SANDBOX_MEMORY,
      '--memory-swap',
      this.env.SANDBOX_MEMORY,
      '--pids-limit',
      '512',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,size=1536m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '-v',
      `${input.srcDir}:/workspace:rw`,
      '-w',
      '/workspace',
      ...envArgs,
      image,
      'sh',
      '-c',
      buildScript(config.installCommand, config.buildCommand, config.rootDir),
    ];

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void run('docker', ['kill', name]);
    }, this.env.BUILD_TIMEOUT_S * 1000);
    const onAbort = () => void run('docker', ['kill', name]);
    signal.addEventListener('abort', onAbort, { once: true });

    let exitCode: number | null;
    try {
      exitCode = await run('docker', args, (l) => log.write(l));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    const durationMs = Date.now() - started;
    if (signal.aborted)
      return { ok: false, exitCode, reason: 'canceled', durationMs, indexDirs: [] };
    if (timedOut) {
      log.write(`autodeploy: build exceeded ${this.env.BUILD_TIMEOUT_S}s and was stopped`);
      return { ok: false, exitCode, reason: 'timeout', durationMs, indexDirs: [] };
    }
    const projectRoot =
      config.rootDir && config.rootDir !== '.' ? join(input.srcDir, config.rootDir) : input.srcDir;
    if (exitCode !== 0) {
      if (exitCode === 137)
        log.write('autodeploy: the build was killed (exit code 137): likely out of memory');
      return { ok: false, exitCode, reason: 'failed', durationMs, indexDirs: [] };
    }
    if (config.mode === 'ssr') {
      const serverDir = await findStandaloneServer(
        join(projectRoot, config.outputDir, 'standalone'),
      );
      if (!serverDir) {
        log.write(
          `autodeploy: the build did not produce a standalone server (${config.outputDir}/standalone/server.js)`,
        );
        return { ok: false, exitCode, reason: 'output_missing', durationMs, indexDirs: [] };
      }
      return {
        ok: true,
        outputDir: join(projectRoot, config.outputDir),
        durationMs,
        serverDir,
        projectRoot,
      };
    }
    const outputDir = join(projectRoot, config.outputDir);
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

/** Applies an AI-proposed unified diff to the workspace (already policy-checked). */
export async function applyPatch(
  srcDir: string,
  diff: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', '--whitespace=nowarn', '--recount', '-'], {
      cwd: srcDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.stdin.end(diff.endsWith('\n') ? diff : `${diff}\n`);
  });
}

export { run as runProcess };

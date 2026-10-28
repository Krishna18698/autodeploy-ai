import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NEXT_SERVER } from '@autodeploy/core';
import type { Env } from '../env.js';
import { inspectBuild } from './inspect.js';
import { proxyByAddress } from './proxy-address.js';
import type { ExecuteInput, ExecuteResult, Executor } from './types.js';

// Moved to inspect.ts (shared with the GitHub Actions executor); kept here for existing imports.
export { findIndexDirs, findStandaloneServer } from './inspect.js';

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

export class SandboxExecutor implements Executor {
  readonly name = 'sandbox' as const;
  constructor(
    private readonly env: Env,
    private readonly warn: (fields: object, msg: string) => void = () => {},
  ) {}

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
    const server = config.mode === 'ssr' ? (config.server ?? NEXT_SERVER) : null;
    if (server?.bundle === 'next-standalone') env.NEXT_PRIVATE_STANDALONE = '1';
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
      '--cpu-shares',
      String(this.env.SANDBOX_CPU_SHARES),
      ...(this.env.SANDBOX_CGROUP_PARENT
        ? ['--cgroup-parent', this.env.SANDBOX_CGROUP_PARENT]
        : []),
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
      if (exitCode === 125 && this.env.SANDBOX_CGROUP_PARENT && !signal.aborted && !timedOut) {
        // Docker itself refused (125), with the builds' CPU group in play: a
        // build without the CPU split beats a build that doesn't run.
        this.warn(
          { attemptId: input.attemptId, cgroupParent: this.env.SANDBOX_CGROUP_PARENT },
          'could not start the build in its CPU group; starting it without',
        );
        await run('docker', ['rm', '-f', name]);
        const i = args.indexOf('--cgroup-parent');
        exitCode = await run('docker', [...args.slice(0, i), ...args.slice(i + 2)], (l) =>
          log.write(l),
        );
      }
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
    if (exitCode !== 0) {
      if (exitCode === 137)
        log.write('autodeploy: the build was killed (exit code 137): likely out of memory');
      return { ok: false, exitCode, reason: 'failed', durationMs, indexDirs: [] };
    }
    return inspectBuild({ srcDir: input.srcDir, config, log }, exitCode, durationMs);
  }
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

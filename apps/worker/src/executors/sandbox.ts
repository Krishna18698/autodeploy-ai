import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Env } from '../env.js';
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
  return `set -e\n${cd}echo "▸ node $(node --version) on $(uname -m)"\n${installCommand ? step('install', installCommand) : ''}${buildCommand ? step('build', buildCommand) : ''}`;
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
    const proxy = this.env.SANDBOX_PROXY;
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
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1',
      NEXT_TELEMETRY_DISABLED: '1',
      ASTRO_TELEMETRY_DISABLED: '1',
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const image = `${this.env.SANDBOX_IMAGE_PREFIX}${config.nodeVersion}`;
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

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import {
  CI_PART_MAX_BYTES,
  CI_WORKFLOW_PATH,
  CI_WORKFLOW_VERSION,
  type CiDone,
  type CiJob,
  type CiState,
  ciAudience,
  ciKeys,
  ciPartKey,
  ciPartsPrefix,
  NEXT_SERVER,
} from '@autodeploy/core';
import { randomToken } from '@autodeploy/crypto';
import { ciWorkflowVersion, type GitHubClient, type RepoRef } from '@autodeploy/github';
import type { Storage } from '@autodeploy/storage';
import type { Valkey } from 'iovalkey';
import type { Env } from '../env.js';
import { inspectBuild } from './inspect.js';
import { buildScript } from './sandbox.js';
import type { ExecuteInput, ExecuteResult, Executor } from './types.js';

// Second executor (ADR 0010): the build runs as a workflow in the *user's own*
// repository (the use GitHub's Actions terms allow), started by the GitHub
// App. The workflow claims the attempt from the API with its OIDC job token,
// streams its log and sends the built checkout back in parts; this side
// relays the log, waits (cancelling the run when the deploy is cancelled or
// out of time), then unpacks the output over the checkout and finds what the
// build produced exactly as the sandbox does.

export type GitHubActionsDeps = {
  env: Pick<
    Env,
    | 'API_PUBLIC_URL'
    | 'BUILD_TIMEOUT_S'
    | 'CI_MAX_OUTPUT_MB'
    | 'CI_MAX_UNPACKED_MB'
    | 'CI_START_TIMEOUT_S'
  >;
  valkey: Valkey;
  storage: Pick<Storage, 'getStream' | 'deletePrefix'>;
  /** The repository's installation; null when the GitHub App isn't configured. */
  github: Pick<GitHubClient, 'fileText' | 'dispatchWorkflow' | 'cancelRun'> | null;
  warn: (fields: object, msg: string) => void;
  /** Between checks on the run; tests shorten it. */
  pollMs?: number;
};

export type GitHubActionsTarget = {
  repo: RepoRef;
  /** owner/name as stored for the project. */
  fullName: string;
  /** Where the workflow lives and is started from. */
  branch: string;
  sha: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  /** The run's name on GitHub. */
  label: string;
};

export class GitHubActionsExecutor implements Executor {
  readonly name = 'github_actions' as const;
  constructor(
    private readonly d: GitHubActionsDeps,
    private readonly t: GitHubActionsTarget,
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const { config, log, signal, attemptId } = input;
    const started = Date.now();
    const end = (r: Omit<Extract<ExecuteResult, { ok: false }>, 'durationMs' | 'indexDirs'>) => ({
      ...r,
      durationMs: Date.now() - started,
      indexDirs: [],
    });
    const fail = (msg: string) => {
      log.write(`autodeploy: ${msg}`);
      return end({ ok: false, exitCode: null, reason: 'failed' });
    };
    const gh = this.d.github;
    if (!gh)
      return fail(
        'building on GitHub Actions needs the GitHub App, which is not configured on this server',
      );

    // 1. Our workflow, on the branch it's started from.
    const text = await gh.fileText(this.t.repo, CI_WORKFLOW_PATH, this.t.branch).catch(() => null);
    if (!text || ciWorkflowVersion(text) === 0)
      return fail(
        `${CI_WORKFLOW_PATH} is not on ${this.t.branch}: merge the setup pull request (project settings → Build on), or switch the project back to building on AutoDeploy`,
      );
    if (ciWorkflowVersion(text) < CI_WORKFLOW_VERSION)
      log.write(
        'autodeploy: this repository has an older AutoDeploy workflow; project settings can update it',
      );

    // 2. What the API will accept for this attempt, and from whom.
    const k = ciKeys(attemptId);
    const ttl = this.d.env.BUILD_TIMEOUT_S + 2 * 3600;
    const state: CiState = {
      nonce: randomToken(32),
      repo: this.t.fullName.toLowerCase(),
      deploymentId: this.t.deploymentId,
      projectId: this.t.projectId,
      orgId: this.t.orgId,
      maxBytes: this.d.env.CI_MAX_OUTPUT_MB * 1024 * 1024,
    };
    await this.d.valkey.set(k.state, JSON.stringify(state), 'EX', ttl);
    let runId: string | null = null;
    const cleanup = async () => {
      await this.d.valkey.del(k.state, k.run, k.log, k.logCount, k.bytes, k.done).catch(() => 0);
      await this.d.storage
        .deletePrefix(ciPartsPrefix(attemptId))
        .catch((err) => this.d.warn({ err, attemptId }, 'could not delete a GitHub build output'));
    };
    const cancel = async () => {
      if (runId) await gh.cancelRun(this.t.repo, runId).catch(() => {});
    };

    try {
      // 3. Start the workflow.
      const job: CiJob = {
        v: CI_WORKFLOW_VERSION,
        api: ciAudience(this.d.env.API_PUBLIC_URL),
        attemptId,
        nonce: state.nonce,
        sha: this.t.sha,
        node: config.nodeVersion,
        script: buildScript(config.installCommand, config.buildCommand, config.rootDir),
        ...(config.patch && { patch: config.patch }),
        root: config.rootDir || '.',
        env: config.env,
        keep: keepFor(config),
        partBytes: CI_PART_MAX_BYTES,
        label: this.t.label,
      };
      try {
        await gh.dispatchWorkflow(this.t.repo, posix.basename(CI_WORKFLOW_PATH), this.t.branch, {
          job: JSON.stringify(job),
        });
      } catch (err) {
        return fail(`GitHub would not start the workflow: ${(err as Error).message}`);
      }
      log.write('autodeploy: asked GitHub Actions to build this commit; waiting for a runner');

      // 4. Relay the log until the workflow reports the end.
      const startBy = Date.now() + this.d.env.CI_START_TIMEOUT_S * 1000;
      let buildBy = 0;
      let done: CiDone | null = null;
      const drain = async () => {
        for (;;) {
          const lines = await this.d.valkey.lrange(k.log, 0, 499);
          if (lines.length === 0) return;
          await this.d.valkey.ltrim(k.log, lines.length, -1);
          for (const l of lines) log.write(l);
        }
      };
      while (!done) {
        if (signal.aborted) {
          await cancel();
          return end({ ok: false, exitCode: null, reason: 'canceled' });
        }
        await drain();
        if (!runId) {
          runId = await this.d.valkey.get(k.run);
          if (runId) {
            buildBy = Date.now() + this.d.env.BUILD_TIMEOUT_S * 1000;
            log.write(
              `autodeploy: building on GitHub: https://github.com/${this.t.fullName}/actions/runs/${runId}`,
            );
          } else if (Date.now() > startBy) {
            return fail(
              `GitHub Actions did not start the build within ${Math.round(this.d.env.CI_START_TIMEOUT_S / 60)} minutes (no runner free, or Actions is turned off for this repository)`,
            );
          }
        } else if (Date.now() > buildBy) {
          await cancel();
          log.write(`autodeploy: build exceeded ${this.d.env.BUILD_TIMEOUT_S}s and was stopped`);
          return end({ ok: false, exitCode: null, reason: 'timeout' });
        }
        const raw = await this.d.valkey.get(k.done);
        if (raw) done = JSON.parse(raw) as CiDone;
        else await sleep(this.d.pollMs ?? 1000, signal);
      }
      await drain();
      if (done.exitCode !== 0) return end({ ok: false, exitCode: done.exitCode, reason: 'failed' });

      // 5. The output, over the checkout; then what it holds, as for the sandbox.
      const unpacked = await this.unpack(attemptId, done.parts, input.srcDir);
      if (unpacked) return fail(unpacked);
      return inspectBuild({ srcDir: input.srcDir, config, log }, 0, Date.now() - started);
    } finally {
      await cleanup();
    }
  }

  /** Joins the parts, checks the archive, unpacks it; an error message, or null. */
  private async unpack(attemptId: string, parts: number, srcDir: string): Promise<string | null> {
    const file = join(dirname(srcDir), `github-output-${attemptId}.tgz`);
    try {
      const out = createWriteStream(file);
      for (let n = 0; n < parts; n++) {
        const obj = await this.d.storage.getStream(ciPartKey(attemptId, n));
        if (!obj) return `part ${n + 1} of the build output never arrived`;
        await append(obj.body as Readable, out);
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );

      // Listing writes nothing. Every path inside the checkout; only files,
      // folders and symlinks (no hard links or devices); nothing under one of
      // the archive's own symlinks (it would be written through the link);
      // and not more than the cap once unpacked (a compressed bomb).
      const names = await tarList(file, false);
      const verbose = await tarList(file, true);
      if (names === null || verbose === null || names.length !== verbose.length)
        return 'the build output is not a readable archive';
      const links: string[] = [];
      let total = 0;
      for (const [i, name] of names.entries()) {
        const line = verbose[i] ?? '';
        if (name.startsWith('/') || name.split('/').includes('..'))
          return `the build output tries to write outside the checkout (${name})`;
        if (!'-dl'.includes(line[0] ?? '?') || line.includes(' link to '))
          return `the build output holds something other than files, folders and symlinks (${name})`;
        if (line[0] === 'l') links.push(name.replace(/\/$/, ''));
        total += sizeOf(line);
      }
      const through = names.find((n) => links.some((l) => n.startsWith(`${l}/`)));
      if (through !== undefined) return `the build output writes through a symlink (${through})`;
      const cap = this.d.env.CI_MAX_UNPACKED_MB * 1024 * 1024;
      if (total > cap)
        return `the build output unpacks to more than ${this.d.env.CI_MAX_UNPACKED_MB} MB`;
      // Into an empty folder: the archive is the whole built checkout, and a
      // symlink left in the original one can't be followed.
      await rm(srcDir, { recursive: true, force: true });
      await mkdir(srcDir, { recursive: true });
      const code = await run('tar', [
        '-xzf',
        file,
        '-C',
        srcDir,
        '--no-same-owner',
        '--no-same-permissions',
      ]);
      return code === 0 ? null : 'could not unpack the build output';
    } finally {
      await rm(file, { force: true });
    }
  }
}

/** Which node_modules a server needs back: none for static sites. */
export function keepFor(config: ExecuteInput['config']): CiJob['keep'] {
  const server = config.mode === 'ssr' ? (config.server ?? NEXT_SERVER) : null;
  const under = (...p: string[]) =>
    posix.normalize(posix.join(config.rootDir || '.', ...p)).replace(/^\.\//, '');
  if (!server) return { deps: 'none' };
  if (server.bundle === 'project') return { deps: 'all' };
  if (server.bundle === 'next-standalone')
    return { deps: 'under', path: under(config.outputDir, 'standalone') };
  return { deps: 'under', path: under(server.dir ?? '.output') };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

function append(from: Readable, to: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    from.on('error', reject);
    from.on('end', resolve);
    from.pipe(to, { end: false });
  });
}

function run(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve(null));
    p.on('close', resolve);
  });
}

/**
 * An entry's size from tar's verbose listing: GNU tar (the VM) prints
 * "perms owner/group size …", BSD tar (a Mac) "perms links owner group size …".
 */
export function sizeOf(line: string): number {
  const f = line.trim().split(/\s+/);
  return Number(f[1]?.includes('/') ? f[2] : f[4]) || 0;
}

/** tar's listing of an archive (verbose: type, size…), or null when unreadable. */
function tarList(file: string, verbose: boolean): Promise<string[] | null> {
  return new Promise((resolve) => {
    const p = spawn('tar', [verbose ? '-tzvf' : '-tzf', file], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) =>
      resolve(
        code === 0
          ? out
              .split('\n')
              .filter(Boolean)
              .map((l) => l.replace(/^\.\//, ''))
          : null,
      ),
    );
  });
}

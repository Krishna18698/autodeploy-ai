import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANALYSIS_VERSION,
  type Analysis,
  analyze,
  type BuildConfig,
  buildConfigFrom,
  classify,
  createRedactor,
  type DeploymentStatus,
  NEXT_SERVER,
  routeKey,
} from '@autodeploy/core';
import {
  activate,
  isTakenDown,
  recordEvent,
  restoreRoutes,
  routeValue,
  TAKEN_DOWN,
  takeDownRoutes,
  transition,
} from '@autodeploy/db';
import { readTree } from '@autodeploy/github';
import { enqueue } from '@autodeploy/queue';
import { retry } from '@autodeploy/resilience';
import { currentTraceparent, withSpan } from '@autodeploy/telemetry';
import type { Deps } from '../deps.js';
import { GitHubActionsExecutor } from '../executors/github-actions.js';
import { inside } from '../executors/paths.js';
import { applyPatch, SandboxExecutor } from '../executors/sandbox.js';
import type { Executor } from '../executors/types.js';
import { metrics } from '../metrics.js';
import { storeArtifact } from '../pipeline/artifact.js';
import { LogSink } from '../pipeline/logs.js';
import {
  assembleServer,
  assembleSsr,
  BUNDLE_EXCLUDES,
  packRuntimeBundle,
  uploadRuntimeBundle,
} from '../pipeline/runtime-bundle.js';
import { loadSecrets } from '../pipeline/secrets.js';
import { cleanupWorkspace, fetchSource, workspaceFor } from '../pipeline/source.js';
import { validateSite } from '../pipeline/validate.js';
import type { JobContext } from '../runner.js';

type DepRow = {
  id: string;
  org_id: string;
  project_id: string;
  number: number;
  status: DeploymentStatus;
  kind: 'production' | 'preview';
  commit_sha: string | null;
  pr_number: number | null;
  build_config: BuildConfig | null;
  started_at: Date | null;
  slug: string;
  repo_url: string;
  repo_full_name: string;
  root_dir: string;
  executor: 'sandbox' | 'github_actions';
  installation_id: number | null;
  node_version: number | null;
  install_command: string | null;
  build_command: string | null;
  output_dir: string | null;
};

export async function loadDeployment(deps: Deps, id: string): Promise<DepRow | undefined> {
  const [row] = await deps.sql<DepRow[]>`
    select d.id, d.org_id, d.project_id, d.number, d.status, d.kind, d.commit_sha, d.pr_number, d.build_config, d.started_at,
           p.slug, p.repo_url, p.repo_full_name, p.root_dir, p.executor, p.installation_id,
           p.node_version, p.install_command, p.build_command, p.output_dir
    from deployments d join projects p on p.id = d.project_id where d.id = ${id}`;
  return row;
}

// ------------------------------------------------------------------ prepare

/** CREATED → ANALYZING → QUEUED: resolve how to build this commit. */
export async function prepareDeployment(deps: Deps, ctx: JobContext): Promise<void> {
  const { deploymentId, traceparent } = ctx.job.payload as {
    deploymentId: string;
    traceparent?: string;
  };
  await withSpan('deployment.prepare', traceparent, { 'deployment.id': deploymentId }, async () => {
    const d = await loadDeployment(deps, deploymentId);
    if (!d || d.status === 'CANCELED' || d.status === 'FAILED') return;
    if (d.status === 'CREATED') {
      await deps.sql.begin((tx) =>
        transition(tx, { deploymentId, to: 'ANALYZING', expectFrom: ['CREATED'] }),
      );
    } else if (d.status !== 'ANALYZING') {
      return; // already past this stage (duplicate delivery)
    }

    const dir = await mkdtemp(join(await ensureDir(join(deps.env.WORK_DIR, 'analyze')), 'a-'));
    let analysis: Analysis;
    try {
      const cacheKey = `analysis:v${ANALYSIS_VERSION}:${d.repo_full_name}:${d.commit_sha}:${d.root_dir}`;
      const cached = d.repo_url.startsWith('file://') ? null : await deps.valkey.get(cacheKey);
      if (cached) {
        analysis = JSON.parse(cached) as Analysis;
      } else {
        await fetchSource(deps, d.repo_url, d.commit_sha ?? 'HEAD', dir, d.installation_id);
        analysis = analyze(await readTree(dir), d.root_dir);
        if (!d.repo_url.startsWith('file://'))
          await deps.valkey.set(cacheKey, JSON.stringify(analysis), 'EX', 7 * 86400);
      }
    } catch (err) {
      await deps.sql.begin((tx) =>
        transition(tx, {
          deploymentId,
          to: 'FAILED',
          set: {
            error_summary: `Could not fetch the source: ${(err as Error).message}`.slice(0, 500),
          },
        }),
      );
      return;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const config = buildConfigFrom(analysis, {
      ...(d.node_version !== null && { nodeVersion: d.node_version }),
      ...(d.install_command !== null && { installCommand: d.install_command }),
      ...(d.build_command !== null && { buildCommand: d.build_command }),
      ...(d.output_dir !== null && { outputDir: d.output_dir }),
      rootDir: d.root_dir,
    });

    await deps.sql.begin(async (tx) => {
      await tx`update projects set analysis = ${tx.json(analysis as never)}, framework = ${analysis.framework.value} where id = ${d.project_id}`;
      await recordEvent(tx, { id: d.id, org_id: d.org_id, project_id: d.project_id }, 'analyzed', {
        framework: analysis.framework.value,
        packageManager: analysis.packageManager.value,
        node: config.nodeVersion,
        buildCommand: config.buildCommand,
        outputDir: config.outputDir,
        warnings: analysis.warnings,
      });
      if (!analysis.supported) {
        await transition(tx, {
          deploymentId,
          to: 'FAILED',
          set: { error_summary: analysis.unsupportedReason ?? 'Unsupported project' },
        });
        return;
      }
      const missing = await missingEnv(tx as never, d.project_id, analysis.envVars.value);
      if (missing.length > 0) {
        await recordEvent(
          tx,
          { id: d.id, org_id: d.org_id, project_id: d.project_id },
          'env_warning',
          {
            missing,
            note: 'Referenced in source but not set. The build continues; set them if the site needs them.',
          },
        );
      }
      await transition(tx, { deploymentId, to: 'QUEUED', set: { build_config: config as never } });
      await enqueue(
        tx,
        'deployment.build',
        { deploymentId, config, traceparent },
        { orgId: d.org_id, idempotencyKey: `build:${deploymentId}:1` },
      );
    });
  });
}

async function missingEnv(
  tx: Deps['sql'],
  projectId: string,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await tx<
    { key: string }[]
  >`select key from env_vars where project_id = ${projectId} and key = any(${names as string[]})`;
  const have = new Set(rows.map((r) => r.key));
  return names.filter((n) => !have.has(n));
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
  return p;
}

// -------------------------------------------------------------------- build

export async function buildDeployment(deps: Deps, ctx: JobContext): Promise<void> {
  const payload = ctx.job.payload as {
    deploymentId: string;
    config?: BuildConfig;
    traceparent?: string;
    repairId?: string;
  };
  const { deploymentId } = payload;
  await withSpan(
    'deployment.build',
    payload.traceparent,
    { 'deployment.id': deploymentId },
    async (span) => {
      const d = await loadDeployment(deps, deploymentId);
      if (!d) return;
      if (d.status === 'VALIDATING') {
        // A previous run died between building and publishing: redo the build.
        await deps.sql.begin((tx) =>
          transition(tx, {
            deploymentId,
            to: 'QUEUED',
            expectFrom: ['VALIDATING'],
            payload: { reason: 'validation interrupted; rebuilding' },
          }),
        );
        d.status = 'QUEUED';
      }
      if (d.status === 'QUEUED') {
        await deps.sql.begin((tx) =>
          transition(tx, {
            deploymentId,
            to: 'BUILDING',
            expectFrom: ['QUEUED'],
            ...(d.started_at ? {} : { set: { started_at: new Date() } }),
          }),
        );
      } else if (d.status !== 'BUILDING') {
        return; // canceled or already handled
      }
      // A previous holder of this job died mid-build: close its attempt out.
      await deps.sql`update deployment_attempts set status = 'canceled', finished_at = now(), error_code = 'WORKER_LOST'
      where deployment_id = ${deploymentId} and status = 'running'`;

      const config = payload.config ?? d.build_config;
      if (!config) throw new Error('deployment has no build config');
      const [attempt] = await deps.sql<{ id: string; attempt_no: number }[]>`
      insert into deployment_attempts (deployment_id, org_id, attempt_no, executor, worker_id, build_config)
      select ${deploymentId}, ${d.org_id}, coalesce(max(attempt_no), 0) + 1, ${d.executor}, ${ctx.workerId}, ${deps.sql.json(config as never)}
      from deployment_attempts where deployment_id = ${deploymentId}
      returning id, attempt_no`;
      if (!attempt) throw new Error('attempt insert failed');
      span.setAttribute('attempt.no', attempt.attempt_no);

      const ws = workspaceFor(deps, attempt.id);
      const secrets = await loadSecrets(deps, d.project_id);
      const log = new LogSink(
        deps,
        {
          orgId: d.org_id,
          projectId: d.project_id,
          deploymentId,
          attemptId: attempt.id,
          attemptNo: attempt.attempt_no,
        },
        createRedactor(Object.values(secrets)),
      );
      const executor: Executor =
        d.executor === 'github_actions'
          ? new GitHubActionsExecutor(Boolean(deps.installations))
          : new SandboxExecutor(deps.env);

      try {
        log.stage(`attempt ${attempt.attempt_no} · ${executor.name} · node ${config.nodeVersion}`);
        await fetchSource(deps, d.repo_url, d.commit_sha ?? 'HEAD', ws.src, d.installation_id);
        if (config.patch) {
          log.stage('applying proposed repair');
          // Patch paths are relative to the project's root directory (the files
          // the AI was shown), not the repository root.
          const applied = await applyPatch(await inside(ws.src, config.rootDir), config.patch);
          if (!applied.ok) {
            log.write(`autodeploy: the proposed patch did not apply cleanly: ${applied.output}`);
            await finishFailed(deps, d, attempt, log, null, [], 'patch did not apply');
            return;
          }
        }
        const result = await executor.execute({
          attemptId: attempt.id,
          srcDir: ws.src,
          config,
          secrets,
          log,
          signal: ctx.signal,
        });
        metrics.buildSeconds.observe(
          { outcome: result.ok ? 'ok' : result.reason },
          result.durationMs / 1000,
        );

        if (!result.ok) {
          if (result.reason === 'canceled') {
            await log.close();
            await deps.sql`update deployment_attempts set status = 'canceled', finished_at = now(), log_lines = ${log.lineCount}, duration_ms = ${result.durationMs} where id = ${attempt.id}`;
            if (ctx.abortReason() === 'canceled') {
              await deps.sql.begin((tx) =>
                transition(tx, { deploymentId, to: 'CANCELED', payload: { during: 'build' } }),
              );
            }
            return;
          }
          await finishFailed(
            deps,
            d,
            attempt,
            log,
            result.exitCode,
            result.indexDirs,
            result.reason,
            result.durationMs,
          );
          return;
        }

        // ---- validate, store, publish ----
        // Server builds: split into static assets + a runtime bundle (ADR 0008).
        const server = config.mode === 'ssr' ? (config.server ?? NEXT_SERVER) : null;
        let ssr: { bundleDir: string; assetsDir: string; workdir: string } | null = null;
        let excludes: readonly string[] = [];
        if (server?.bundle === 'next-standalone' && result.serverDir && result.projectRoot) {
          const out = join(ws.out, 'ssr');
          ssr = {
            ...(await assembleSsr(result.serverDir, result.projectRoot, config.outputDir, out)),
            workdir: '.',
          };
        } else if (server && result.bundleDir && result.projectRoot) {
          ssr = await assembleServer(
            server,
            result.projectRoot,
            result.bundleDir,
            config.rootDir,
            join(ws.out, 'ssr'),
          );
          excludes = BUNDLE_EXCLUDES;
        }
        const packed = ssr
          ? await packRuntimeBundle(ssr.bundleDir, {
              file: join(ws.out, 'runtime.tar.gz'),
              excludes,
            })
          : null;
        if (ssr && packed) {
          const mb = packed.bytes / 1024 / 1024;
          if (mb > deps.env.RUNTIME_BUNDLE_MAX_MB) {
            log.write(
              `autodeploy: the server bundle is ${mb.toFixed(0)} MB compressed; the limit is ${deps.env.RUNTIME_BUNDLE_MAX_MB} MB. Keep build-only packages in devDependencies, or trim what the project ships.`,
            );
            await finishFailed(deps, d, attempt, log, null, [], 'server bundle too large');
            return;
          }
          log.stage(`server bundle ${mb.toFixed(1)} MB · starting it for validation`);
        }
        log.stage('validating in headless Chromium');
        await log.close();
        await deps.sql.begin(async (tx) => {
          await tx`update deployment_attempts set status = 'succeeded', finished_at = now(), log_lines = ${log.lineCount}, duration_ms = ${result.durationMs}, exit_code = 0 where id = ${attempt.id}`;
          await transition(tx, {
            deploymentId,
            to: 'VALIDATING',
            payload: { attemptNo: attempt.attempt_no, buildMs: result.durationMs },
          });
        });

        const validation = await validateSite(
          deps,
          ssr ? ssr.bundleDir : result.outputDir,
          join(ws.out, 'validation'),
          ctx.signal,
          ssr && server
            ? { ssr: true, env: secrets, start: server.start, workdir: ssr.workdir }
            : undefined,
        );
        if (!validation.ok) {
          for (const e of [
            ...validation.pageErrors,
            ...validation.failedRequests.map((f) => `failed request ${f}`),
          ]) {
            log.write(`autodeploy: validation: ${e}`);
          }
          await log.close();
          await deps.sql`update deployment_attempts set log_lines = ${log.lineCount} where id = ${attempt.id}`;
          const sig = classify([
            ...validation.pageErrors,
            ...validation.failedRequests.map((f) => `Failed to load ${f}`),
          ]);
          await deps.sql.begin(async (tx) => {
            await tx`update deployment_attempts set status = 'failed', error_code = ${'VALIDATION'}, error_signature = ${`VALIDATION:${sig.signature.split(':')[1]}`},
            error_detail = ${tx.json({ excerpt: sig.excerpt, captures: sig.captures, validation } as never)} where id = ${attempt.id}`;
            await transition(tx, {
              deploymentId,
              to: 'BUILD_FAILED',
              payload: {
                stage: 'validation',
                status: validation.status,
                pageErrors: validation.pageErrors.slice(0, 5),
                failedRequests: validation.failedRequests.slice(0, 5),
              },
              set: {
                error_summary:
                  `Validation failed: ${validation.pageErrors[0] ?? validation.failedRequests[0] ?? `HTTP ${validation.status}`}`.slice(
                    0,
                    500,
                  ),
              },
            });
            await enqueue(
              tx,
              'deployment.recover',
              { deploymentId, attemptId: attempt.id, traceparent: currentTraceparent() },
              { orgId: d.org_id, idempotencyKey: `recover:${attempt.id}` },
            );
          });
          return;
        }

        // Object storage blips shouldn't cost a rebuild: retry the upload in place.
        const uploadRetry = {
          attempts: 6,
          baseMs: 1_000,
          capMs: 15_000,
          onRetry: (err: unknown, n: number, delay: number) =>
            deps.log.warn({ err, attempt: n, delay }, 'artifact upload failed; retrying'),
        };
        const artifact = await retry(
          () => storeArtifact(deps, ssr ? ssr.assetsDir : result.outputDir),
          uploadRetry,
        );
        const runtime = packed
          ? { ...packed, reused: await retry(() => uploadRuntimeBundle(deps, packed), uploadRetry) }
          : null;
        let screenshotKey: string | null = null;
        if (validation.screenshotPath) {
          screenshotKey = `screenshots/${deploymentId}.png`;
          await deps.storage.put(
            screenshotKey,
            await readFile(validation.screenshotPath),
            'image/png',
          );
        }
        // Immutable per-deployment URL (and the PR preview URL) are routable as soon as the build is good.
        const value = routeValue({
          deploymentId,
          number: d.number,
          artifactSha: artifact.sha256,
          projectSlug: d.slug,
          mode: runtime ? 'ssr' : 'static',
        });
        const modeColumns =
          runtime && server && ssr
            ? {
                mode: 'ssr' as const,
                runtime_sha: runtime.sha256,
                runtime_node: config.nodeVersion,
                runtime_command: server.start,
                runtime_workdir: ssr.workdir,
              }
            : {};
        // A site taken down while this built gets the notice at its new addresses too.
        const served = (await isTakenDown(deps.sql, d.project_id)) ? TAKEN_DOWN : value;
        await deps.routes.put(
          routeKey({ kind: 'deployment', slug: d.slug, number: d.number }),
          served,
        );
        if (d.kind === 'preview' && d.pr_number !== null)
          await deps.routes.put(
            routeKey({ kind: 'preview', slug: d.slug, pr: d.pr_number }),
            served,
          );

        await deps.sql.begin(async (tx) => {
          await recordEvent(
            tx,
            { id: d.id, org_id: d.org_id, project_id: d.project_id },
            'validated',
            {
              title: validation.title,
              status: validation.status,
              skipped: validation.skipped,
              consoleErrors: validation.consoleErrors.slice(0, 5),
              externalBlocked: validation.externalBlocked,
              artifact: {
                sha256: artifact.sha256,
                files: artifact.fileCount,
                bytes: artifact.bytes,
                reused: artifact.reused,
              },
              ...(runtime && {
                runtime: { sha256: runtime.sha256, bytes: runtime.bytes, reused: runtime.reused },
              }),
            },
          );
          const rule = await tx<{ id: string }[]>`update repair_attempts set status = 'validated'
          where deployment_id = ${deploymentId} and strategy = 'rule' and status = 'applied' returning id`;
          // A validated rule fix becomes the project's setting, so the next
          // deploy doesn't have to fail first (only where the user hasn't set one).
          if (rule.length > 0 && !config.patch) await learnSettings(tx as never, d, config);
          if (config.requiresApproval) {
            await tx`update repair_attempts set status = 'awaiting_approval' where id = ${payload.repairId ?? null}`;
            await transition(tx, {
              deploymentId,
              to: 'AWAITING_APPROVAL',
              set: { artifact_id: artifact.id, screenshot_key: screenshotKey, ...modeColumns },
              payload: { repairId: payload.repairId ?? null },
            });
            return;
          }
          await transition(tx, {
            deploymentId,
            to: 'READY',
            set: {
              artifact_id: artifact.id,
              screenshot_key: screenshotKey,
              ...modeColumns,
              ...(rule.length > 0 && { recovered_by: 'rule' as const }),
            },
            payload: {
              attempts: attempt.attempt_no,
              recoveredBy: rule.length > 0 ? 'rule' : null,
              buildMs: await sumBuildMs(tx as never, deploymentId),
            },
          });
          if (d.kind === 'production') {
            await enqueue(
              tx,
              'deployment.activate',
              { deploymentId, traceparent: currentTraceparent() },
              { orgId: d.org_id, idempotencyKey: `activate:${deploymentId}` },
            );
          }
        });
      } finally {
        await cleanupWorkspace(ws.root);
      }
    },
  );
}

async function finishFailed(
  deps: Deps,
  d: DepRow,
  attempt: { id: string; attempt_no: number },
  log: LogSink,
  exitCode: number | null,
  indexDirs: string[],
  reason: string,
  durationMs = 0,
) {
  await log.close();
  const sig = classify(log.tail, exitCode ?? undefined);
  await deps.sql.begin(async (tx) => {
    await tx`update deployment_attempts set status = 'failed', finished_at = now(), exit_code = ${exitCode}, log_lines = ${log.lineCount},
      duration_ms = ${durationMs}, error_code = ${sig.code}, error_signature = ${sig.signature},
      error_detail = ${tx.json({ excerpt: sig.excerpt, captures: sig.captures, keyLine: sig.keyLine, indexDirs, reason } as never)}
      where id = ${attempt.id}`;
    await transition(tx, {
      deploymentId: d.id,
      to: 'BUILD_FAILED',
      payload: { attemptNo: attempt.attempt_no, errorCode: sig.code, keyLine: sig.keyLine },
      set: { error_summary: sig.keyLine.slice(0, 500) },
    });
    await enqueue(
      tx,
      'deployment.recover',
      { deploymentId: d.id, attemptId: attempt.id, traceparent: currentTraceparent() },
      { orgId: d.org_id, idempotencyKey: `recover:${attempt.id}` },
    );
  });
}

// ----------------------------------------------------------------- activate

export async function activateDeployment(deps: Deps, ctx: JobContext): Promise<void> {
  const { deploymentId, traceparent } = ctx.job.payload as {
    deploymentId: string;
    traceparent?: string;
  };
  await withSpan('deployment.activate', traceparent, { 'deployment.id': deploymentId }, () =>
    activateInner(deps, deploymentId),
  );
}

async function activateInner(deps: Deps, deploymentId: string): Promise<void> {
  const d = await loadDeployment(deps, deploymentId);
  if (d?.status !== 'READY' || d.kind !== 'production') return;
  if (await isTakenDown(deps.sql, d.project_id)) {
    deps.log.warn({ deploymentId }, 'not activated: the site is taken down');
    return;
  }
  const r = await activate(deps.sql, deps.routes, deploymentId, 'promote', 'autodeploy');
  deps.log.info(
    { deploymentId, ms: Math.round(r.ms), previous: r.previousId },
    'deployment activated',
  );
}

/**
 * Makes a project's addresses match the database: the "taken down" notice
 * while it (or its account) is down, otherwise what is live. Queued by the
 * admin actions; running it twice is harmless.
 */
export async function refreshRoutes(deps: Deps, ctx: JobContext): Promise<void> {
  const { projectId } = ctx.job.payload as { projectId: string };
  const down = await isTakenDown(deps.sql, projectId);
  const n = down
    ? await takeDownRoutes(deps.sql, deps.routes, projectId)
    : await restoreRoutes(deps.sql, deps.routes, projectId);
  deps.log.info({ projectId, down, addresses: n }, 'site routes refreshed');
}

export async function removeRoute(deps: Deps, ctx: JobContext): Promise<void> {
  const { key } = ctx.job.payload as { key: string };
  await deps.routes.delete(key);
}

/** Time actually spent building (all attempts), excluding queueing and approval waits. */
async function sumBuildMs(tx: Deps['sql'], deploymentId: string): Promise<number> {
  const [r] = await tx<
    { ms: number | null }[]
  >`select sum(duration_ms)::int as ms from deployment_attempts where deployment_id = ${deploymentId}`;
  return r?.ms ?? 0;
}

async function learnSettings(tx: Deps['sql'], d: DepRow, config: BuildConfig) {
  const learned: Record<string, unknown> = {};
  if (d.node_version === null) learned.node_version = config.nodeVersion;
  if (d.output_dir === null) learned.output_dir = config.outputDir;
  if (d.install_command === null && config.installCommand)
    learned.install_command = config.installCommand;
  if (d.build_command === null && config.buildCommand) learned.build_command = config.buildCommand;
  const [orig] = await tx<
    { build_config: BuildConfig | null }[]
  >`select build_config from deployments where id = ${d.id}`;
  const base = orig?.build_config;
  // Only persist what the repair actually changed.
  for (const k of Object.keys(learned)) {
    const field = {
      node_version: 'nodeVersion',
      output_dir: 'outputDir',
      install_command: 'installCommand',
      build_command: 'buildCommand',
    }[k] as keyof BuildConfig;
    if (base && base[field] === config[field]) delete learned[k];
  }
  if (Object.keys(learned).length === 0) return;
  await tx`update projects set ${tx(learned)}, version = version + 1, updated_at = now() where id = ${d.project_id}`;
  await recordEvent(
    tx,
    { id: d.id, org_id: d.org_id, project_id: d.project_id },
    'settings_learned',
    learned,
  );
}

'use client';

import type { AnalyzeResult } from '@autodeploy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { RequestAccess } from '@/components/app/access';
import { badRows, EnvEditor, type EnvRow, envToSend, rowsFor } from '@/components/app/env-editor';
import { RepoPicker } from '@/components/app/repo-picker';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Panel, SkeletonRows } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey, post } from '@/lib/api';
import { useMe } from '@/lib/queries';

type Result = z.infer<typeof AnalyzeResult>;

export default function NewProjectPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [repoUrl, setRepoUrl] = useState('');
  // Empty means the top of the repository (shown as the placeholder).
  const [rootDir, setRootDir] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [slug, setSlug] = useState('');
  const [slugState, setSlugState] = useState<{ available: boolean; reason?: string } | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'deploy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Variables to save with the project (owners and admins, as in the Environment tab).
  const me = useMe();
  const canSetEnv = me.data?.org.role === 'owner' || me.data?.org.role === 'admin';
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const detected = result?.analysis.envVars.value.join(',') ?? '';
  useEffect(() => {
    setEnvRows((cur) => rowsFor(detected ? detected.split(',') : [], cur));
  }, [detected]);

  useEffect(() => {
    // Until this slug is checked, show nothing (and keep Deploy disabled).
    setSlugState(null);
    if (!slug) return;
    // A check still in flight for an earlier slug must not land afterwards.
    let current = true;
    const t = setTimeout(async () => {
      const r = await api<{ available: boolean; reason?: string; domain: string }>(
        `/api/v1/slugs/${encodeURIComponent(slug)}`,
      ).catch(() => null);
      if (!current) return;
      setSlugState(r);
      if (r) setDomain(r.domain);
    }, 300);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [slug]);

  const analyze = async (url: string) => {
    setBusy('analyze');
    setError(null);
    setResult(null);
    try {
      const r = await post<Result>('/api/v1/analyze', {
        repoUrl: url.trim(),
        rootDir: rootDir.trim() || '.',
      });
      setResult(r);
      setSlug(r.suggestedSlug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Analysis failed');
    } finally {
      setBusy(null);
    }
  };

  const analyzeRepo = (e: React.FormEvent) => {
    e.preventDefault();
    void analyze(repoUrl);
  };

  const pick = (url: string) => {
    setRepoUrl(url);
    void analyze(url);
  };

  const deploy = async () => {
    setBusy('deploy');
    setError(null);
    try {
      const r = await post<{ project: { id: string }; deploymentId: string | null }>(
        '/api/v1/projects',
        {
          repoUrl: repoUrl.trim(),
          rootDir: rootDir.trim() || '.',
          slug,
          deploy: true,
          ...(canSetEnv && envToSend(envRows).length > 0 && { env: envToSend(envRows) }),
        },
        { idempotencyKey: newIdempotencyKey('create') },
      );
      await qc.invalidateQueries({ queryKey: ['projects'] });
      toast('Project created — first build queued', 'ok');
      router.push(r.deploymentId ? `/deployments/${r.deploymentId}` : `/projects/${r.project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project');
      setBusy(null);
    }
  };

  const a = result?.analysis;
  const rows = a
    ? ([
        [
          'Framework',
          `${a.framework.value}${a.framework.version ? ` ${a.framework.version}` : ''}`,
          a.framework.evidence,
        ],
        ['Package manager', a.packageManager.value, a.packageManager.evidence],
        ['Node', `${a.node.value}.x`, a.node.evidence],
        ['Install', a.installCommand.value ?? '—', a.installCommand.evidence],
        ['Build', a.buildCommand.value ?? '—', a.buildCommand.evidence],
        ['Output', `${a.outputDir.value}/`, a.outputDir.evidence],
        ['Mode', a.mode.value, a.mode.evidence],
      ] as const)
    : [];

  // An API without portfolio mode doesn't say: then it's open, as before.
  if (me.data?.org.canDeploy === false)
    return (
      <>
        <PageHeader title="Import a repository" sub="Deploy your own repositories on AutoDeploy." />
        <RequestAccess />
      </>
    );

  return (
    <>
      <PageHeader
        title="Import a repository"
        sub="Pick a repository the AutoDeploy GitHub App can see, or paste any public repository URL."
      />
      <RepoPicker selected={repoUrl} onPick={pick} />
      <form onSubmit={analyzeRepo} className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-col gap-1.5 text-[12px] text-muted sm:flex-1">
          Repository URL
          <input
            id="repo"
            required
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="h-10 rounded-md border border-line bg-panel px-3 font-mono text-[16px] text-fg outline-none placeholder:text-muted/60 focus:border-run/60 sm:text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted sm:w-40">
          <span>
            Root directory <span className="text-muted/70">(monorepos)</span>
          </span>
          <input
            id="root"
            value={rootDir}
            placeholder="."
            onChange={(e) => setRootDir(e.target.value)}
            className="h-10 w-full rounded-md border border-line bg-panel px-3 font-mono text-[16px] text-fg outline-none focus:border-run/60 sm:text-[13px]"
          />
        </label>
        <Button type="submit" variant="primary" loading={busy === 'analyze'} className="h-10">
          Analyze
        </Button>
      </form>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-[13px] text-fail"
        >
          {error}
        </p>
      )}

      {busy === 'analyze' && !result && (
        <Panel title="Analysis" pad={false}>
          <SkeletonRows rows={7} className="h-6" />
        </Panel>
      )}
      <AnimatePresence>
        {result && a && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-6 flex flex-col gap-4"
          >
            <Panel
              title={`Analysis @ ${result.repo.commitSha.slice(0, 7)}`}
              action={<span className="font-mono text-[11px] text-muted">evidence</span>}
              pad={false}
            >
              <dl className="divide-y divide-line">
                {rows.map(([k, v, ev], i) => (
                  <motion.div
                    key={k}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 px-4 py-2.5 text-[13px] sm:grid-cols-[8rem_14rem_minmax(0,1fr)]"
                  >
                    <dt className="text-muted">{k}</dt>
                    <dd className="font-mono text-fg">{v}</dd>
                    <dd className="col-span-2 truncate font-mono text-[11px] text-muted sm:col-span-1">
                      ← {ev.map((e) => e.detail).join(' · ') || '—'}
                    </dd>
                  </motion.div>
                ))}
              </dl>
            </Panel>
            {a.mode.value === 'ssr' && a.supported && (
              <p className="rounded-md border border-run/40 bg-run/10 px-3 py-2 text-[13px] text-fg/90">
                Runs as a server
                {a.server ? (
                  <>
                    {' '}
                    (<code className="font-mono text-[12px]">{a.server.value.start}</code>)
                  </>
                ) : null}
                : pages and API routes are rendered on request. It sleeps after 15 minutes without
                visitors and wakes on the next one (≈1–3 s).
              </p>
            )}
            {a.supported && canSetEnv && <EnvEditor rows={envRows} onChange={setEnvRows} />}
            {a.supported && !canSetEnv && a.envVars.value.length > 0 && (
              <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn">
                The code uses {a.envVars.value.join(', ')}. Only owners and admins can set
                environment variables: ask one to add them after the import.
              </p>
            )}
            {a.warnings.map((w) => (
              <p key={w} className="text-[12px] text-muted">
                ⚠ {w}
              </p>
            ))}
            {!a.supported ? (
              <p className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-[13px] text-fail">
                {a.unsupportedReason}
              </p>
            ) : (
              <div className="flex flex-col gap-3 rounded-[8px] border border-line bg-panel p-4 sm:flex-row sm:items-center">
                <label htmlFor="slug" className="font-mono text-[13px]">
                  <span className="sr-only">Site address</span>
                  <input
                    id="slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    className="w-40 rounded border border-line bg-bg px-2 py-1 text-fg outline-none focus:border-run/60"
                  />
                  <span className="text-muted">{domain ? `.${domain}` : ''}</span>
                </label>
                <span
                  className={`font-mono text-[12px] ${slugState?.available ? 'text-ok' : 'text-fail'}`}
                  aria-live="polite"
                >
                  {slugState ? (slugState.available ? '✓ available' : `✗ ${slugState.reason}`) : ''}
                </span>
                <Button
                  variant="primary"
                  className="sm:ml-auto"
                  loading={busy === 'deploy'}
                  loader="dots"
                  disabled={!slugState?.available || (canSetEnv && badRows(envRows) > 0)}
                  onClick={deploy}
                >
                  Deploy →
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

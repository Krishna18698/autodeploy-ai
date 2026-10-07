'use client';

import type { AnalyzeResult } from '@autodeploy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { RepoPicker } from '@/components/app/repo-picker';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey, post } from '@/lib/api';

type Result = z.infer<typeof AnalyzeResult>;

export default function NewProjectPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [repoUrl, setRepoUrl] = useState('');
  const [rootDir, setRootDir] = useState('.');
  const [result, setResult] = useState<Result | null>(null);
  const [slug, setSlug] = useState('');
  const [slugState, setSlugState] = useState<{ available: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'deploy' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return setSlugState(null);
    const t = setTimeout(async () => {
      const r = await api<{ available: boolean; reason?: string }>(
        `/api/v1/slugs/${encodeURIComponent(slug)}`,
      ).catch(() => null);
      setSlugState(r);
    }, 300);
    return () => clearTimeout(t);
  }, [slug]);

  const analyze = async (url: string) => {
    setBusy('analyze');
    setError(null);
    setResult(null);
    try {
      const r = await post<Result>('/api/v1/analyze', { repoUrl: url.trim(), rootDir });
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
        { repoUrl: repoUrl.trim(), rootDir, slug, deploy: true },
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

  return (
    <>
      <PageHeader
        title="Import a repository"
        sub="Pick a repository the AutoDeploy GitHub App can see, or paste any public repository URL."
      />
      <RepoPicker selected={repoUrl} onPick={pick} />
      <form onSubmit={analyzeRepo} className="flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="repo">
          Repository URL
        </label>
        <input
          id="repo"
          required
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="h-10 flex-1 rounded-md border border-line bg-panel px-3 font-mono text-[13px] outline-none placeholder:text-muted/60 focus:border-run/60"
        />
        <label className="sr-only" htmlFor="root">
          Root directory
        </label>
        <input
          id="root"
          value={rootDir}
          onChange={(e) => setRootDir(e.target.value || '.')}
          className="h-10 w-full rounded-md border border-line bg-panel px-3 font-mono text-[13px] outline-none focus:border-run/60 sm:w-32"
          title="Root directory (for monorepos)"
        />
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
            {a.envVars.value.length > 0 && (
              <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn">
                References {a.envVars.value.join(', ')} — set them in project settings if the site
                needs them.
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
                  <span className="text-muted">.autodeploy</span>
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
                  disabled={!slugState?.available}
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

'use client';

import { parseDotenv } from '@autodeploy/core/dotenv';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useMemo, useState } from 'react';
import { Screenshot } from '@/components/app/screenshot';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/confirm';
import { Empty, Panel, SkeletonPage, SkeletonRows } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, del, newIdempotencyKey, patch, post, put } from '@/lib/api';
import { ago, shortSha } from '@/lib/format';
import { type DeploymentSummaryT, useDeployments, useEnv, useProject } from '@/lib/queries';

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const project = useProject(id);
  const [tab, setTab] = useState<'deployments' | 'settings' | 'env'>('deployments');
  const qc = useQueryClient();
  const toast = useToast();
  const [deploying, setDeploying] = useState(false);

  if (project.isLoading) return <SkeletonPage panels={['h-10', 'h-72']} />;
  if (!project.data) return <Empty title="Project not found" />;
  const p = project.data;

  const redeploy = async () => {
    setDeploying(true);
    try {
      const d = await post<{ id: string; number: number }>(
        `/api/v1/projects/${id}/deployments`,
        {},
        { idempotencyKey: newIdempotencyKey('deploy') },
      );
      toast(`Deployment #${d.number} queued`, 'ok');
      await qc.invalidateQueries({ queryKey: ['deployments'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start a deployment', 'fail');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <>
      <PageHeader
        title={p.slug}
        sub={
          <span className="font-mono text-[12px]">
            {p.repoFullName} · {p.framework} ·{' '}
            {p.activeDeploymentId ? (
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap text-run hover:underline"
              >
                {p.url.replace('https://', '')} ↗
              </a>
            ) : (
              'not live yet'
            )}
          </span>
        }
        actions={
          <Button variant="primary" loading={deploying} loader="dots" onClick={redeploy}>
            Deploy latest
          </Button>
        }
      />
      <Tabs
        id="project"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'deployments', label: 'Deployments' },
          { id: 'settings', label: 'Build settings' },
          { id: 'env', label: 'Environment' },
        ]}
      />
      <div className="mt-5">
        {tab === 'deployments' && <History projectId={id} />}
        {tab === 'settings' && <Settings project={p} onSaved={() => project.refetch()} />}
        {tab === 'env' && <EnvVars projectId={id} />}
      </div>
    </>
  );
}

function History({ projectId }: { projectId: string }) {
  const deps = useDeployments({ projectId, limit: 50 }, 5_000);
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<DeploymentSummaryT | null>(null);
  const [busy, setBusy] = useState(false);

  const rollback = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await post<{ ms: number }>(`/api/v1/projects/${projectId}/rollback`, {
        deploymentId: target.id,
      });
      toast(`Rolled back to #${target.number} in ${r.ms.toFixed(0)} ms — no rebuild`, 'ok');
      await qc.invalidateQueries();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Rollback failed', 'fail');
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  if (!deps.data)
    return (
      <Panel pad={false}>
        <SkeletonRows rows={5} className="h-12" />
      </Panel>
    );
  if (deps.data.items.length === 0) return <Empty title="No deployments yet" />;
  return (
    <Panel pad={false}>
      <ul className="divide-y divide-line">
        {deps.data.items.map((d) => (
          <li
            key={d.id}
            // Phones: status and actions on a second line under the details.
            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          >
            <Link
              href={`/deployments/${d.id}`}
              className="row-span-2 block h-12 w-20 self-start overflow-hidden rounded border border-line bg-raised sm:row-span-1 sm:self-center"
            >
              {d.screenshotUrl ? (
                <Screenshot
                  url={d.screenshotUrl}
                  alt={`Screenshot of deployment ${d.number}`}
                  className="h-full w-full"
                  imgClassName="h-full w-full object-cover object-top"
                />
              ) : (
                <span className="grid h-full place-items-center font-mono text-[10px] text-muted">
                  no preview
                </span>
              )}
            </Link>
            <div className="min-w-0">
              <Link
                href={`/deployments/${d.id}`}
                className="flex items-center gap-2 text-[13px] hover:underline"
              >
                <span className="font-medium">#{d.number}</span>
                <span className="font-mono text-[12px] text-muted">{shortSha(d.commitSha)}</span>
                <span className="truncate text-muted">{d.commitMessage}</span>
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted">
                <span className="whitespace-nowrap">
                  {d.kind} · {d.trigger} · {ago(d.createdAt)}
                </span>
                {d.recoveredBy && <span className="text-ai">· auto-fixed by {d.recoveredBy}</span>}
                {d.url && (
                  <a
                    href={d.url}
                    className="max-w-full truncate text-run/80 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {d.url.replace('https://', '')} ↗
                  </a>
                )}
              </div>
            </div>
            <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:row-start-1">
              <StatusPill status={d.status} />
              {(d.status === 'SUPERSEDED' || d.status === 'ROLLED_BACK') &&
                d.kind === 'production' && (
                  <Button size="sm" onClick={() => setTarget(d)}>
                    Roll back
                  </Button>
                )}
            </div>
          </li>
        ))}
      </ul>
      <Confirm
        open={target !== null}
        title={`Roll back to #${target?.number}?`}
        body="The site will serve that deployment's files again immediately. Nothing is rebuilt: the live pointer moves back."
        confirmLabel="Roll back"
        loading={busy}
        onConfirm={rollback}
        onClose={() => setTarget(null)}
      />
    </Panel>
  );
}

function Settings({
  project,
  onSaved,
}: {
  project: NonNullable<ReturnType<typeof useProject>['data']>;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    nodeVersion: project.settings.nodeVersion?.toString() ?? '',
    installCommand: project.settings.installCommand ?? '',
    buildCommand: project.settings.buildCommand ?? '',
    outputDir: project.settings.outputDir ?? '',
    rootDir: project.settings.rootDir,
    defaultBranch: project.defaultBranch,
  });
  const [aiRepair, setAiRepair] = useState(project.settings.aiRepair);
  const [saving, setSaving] = useState(false);
  const detected = project.analysis;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await patch(
        `/api/v1/projects/${project.id}`,
        {
          nodeVersion: form.nodeVersion ? Number(form.nodeVersion) : null,
          installCommand: form.installCommand || null,
          buildCommand: form.buildCommand || null,
          outputDir: form.outputDir || null,
          rootDir: form.rootDir || '.',
          defaultBranch: form.defaultBranch,
          aiRepair,
        },
        { 'if-match': `"v${project.version}"` },
      );
      toast('Settings saved', 'ok');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'fail');
    } finally {
      setSaving(false);
    }
  };
  const field = (key: keyof typeof form, label: string, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {label}
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder ? `detected: ${placeholder}` : ''}
        className="h-9 rounded-md border border-line bg-bg px-3 font-mono text-[13px] text-fg outline-none placeholder:text-muted/50 focus:border-run/60"
      />
    </label>
  );
  return (
    <Panel title="Overrides (leave empty to use what the analyzer detects)">
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        {field(
          'nodeVersion',
          'Node version (18, 20, 22, 24)',
          detected ? String(detected.node.value) : undefined,
        )}
        {field('defaultBranch', 'Production branch')}
        {field('installCommand', 'Install command', detected?.installCommand.value ?? undefined)}
        {field('buildCommand', 'Build command', detected?.buildCommand.value ?? undefined)}
        {field('outputDir', 'Output directory', detected?.outputDir.value)}
        {field('rootDir', 'Root directory')}
        <label className="flex items-start gap-3 rounded-md border border-line p-3 text-[13px] sm:col-span-2">
          <input
            type="checkbox"
            checked={aiRepair}
            onChange={(e) => setAiRepair(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-ai)]"
          />
          <span>
            <span className="text-fg">AI repair</span>
            <span className="block text-muted">
              When no rule fixes a failed build, send its log excerpt and the files the error points
              at to AI providers (NVIDIA, OpenRouter, Cloudflare) for a proposed fix, which waits
              for your approval. Turn off to keep your code away from them; rules still run.
            </span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
          <span className="ml-3 font-mono text-[11px] text-muted">
            v{project.version} · saved with optimistic locking
          </span>
        </div>
      </form>
    </Panel>
  );
}

function EnvVars({ projectId }: { projectId: string }) {
  const env = useEnv(projectId);
  const toast = useToast();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await put(`/api/v1/projects/${projectId}/env/${key}`, { value });
      setKey('');
      setValue('');
      await env.refetch();
      toast(`${key} saved (encrypted)`, 'ok');
      setChanged(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'fail');
    }
  };
  const remove = async (k: string) => {
    try {
      await del(`/api/v1/projects/${projectId}/env/${k}`);
      await env.refetch();
      setChanged(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'fail');
    }
  };
  const [importing, setImporting] = useState(false);
  // A change reaches the live site only with the next deploy: offer one.
  const [changed, setChanged] = useState(false);
  return (
    <Panel title="Environment variables · write-only, envelope-encrypted">
      {changed && <RedeployNotice projectId={projectId} onClose={() => setChanged(false)} />}
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>
          {importing ? 'Close import' : 'Import .env'}
        </Button>
      </div>
      {importing && (
        <ImportEnv
          projectId={projectId}
          existing={new Set(env.data?.map((v) => v.key) ?? [])}
          onDone={async () => {
            setImporting(false);
            await env.refetch();
            setChanged(true);
          }}
        />
      )}
      <form onSubmit={add} className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          required
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="VITE_API_URL"
          aria-label="Name"
          className="h-9 rounded-md border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-run/60 sm:w-56"
        />
        <input
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          type="password"
          aria-label="Value"
          className="h-9 rounded-md border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-run/60 sm:flex-1"
        />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>
      {!env.data ? (
        <SkeletonRows rows={3} className="h-8" pad={false} />
      ) : env.data.length ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {env.data.map((v) => (
            <li key={v.key} className="flex items-center gap-3 px-3 py-2 font-mono text-[13px]">
              <span className="text-fg">{v.key}</span>
              <span className="whitespace-nowrap text-muted">{v.preview}</span>
              <span className="ml-auto whitespace-nowrap text-[11px] text-muted">
                {ago(v.updatedAt)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(v.key)}
                aria-label={`Delete ${v.key}`}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">
          No variables yet. Values are never shown again after saving.
        </p>
      )}
    </Panel>
  );
}

/**
 * After a variable changes: the live site keeps the old values until the next
 * deploy. Deploy now starts one and takes you to it (live pipeline and logs);
 * the ✕ leaves it for later.
 */
function RedeployNotice({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const deploy = async () => {
    setBusy(true);
    try {
      const d = await post<{ id: string; number: number }>(
        `/api/v1/projects/${projectId}/deployments`,
        {},
        { idempotencyKey: newIdempotencyKey('deploy') },
      );
      onClose();
      toast(`Deploy #${d.number} started with your new variables`, 'ok');
      await qc.invalidateQueries({ queryKey: ['deployments'] });
      router.push(`/deployments/${d.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start a deploy', 'fail');
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-run/30 bg-run/8 px-4 py-3 text-[13px] sm:flex-row sm:items-center"
    >
      <p className="min-w-0 flex-1 leading-5">
        <strong className="font-medium text-fg">Saved.</strong>{' '}
        <span className="text-fg/80">
          Your live site still uses the old values. Deploy again to use the new ones.
        </span>
      </p>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} loader="dots" onClick={deploy}>
          Deploy now
        </Button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close, deploy later"
          title="Deploy later"
          className="grid size-9 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Paste or pick a .env file; keys are previewed (never values), then saved in one go. */
function ImportEnv({
  projectId,
  existing,
  onDone,
}: {
  projectId: string;
  existing: Set<string>;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseDotenv(text), [text]);
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
    e.target.value = '';
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await post<{ imported: string[] }>(`/api/v1/projects/${projectId}/env/import`, {
        vars: parsed.vars,
      });
      toast(`Imported ${r.imported.length} variables (encrypted)`, 'ok');
      setText('');
      await onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Import failed', 'fail');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-md border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          Paste a .env file, or choose one from your computer.
        </p>
        <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-[12px] hover:bg-raised/60">
          Choose file
          <input type="file" accept=".env,.txt,text/plain" onChange={pick} className="sr-only" />
        </label>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'DATABASE_URL=postgres://…\nVITE_API_URL=https://…'}
        aria-label=".env contents"
        spellCheck={false}
        rows={6}
        className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-run/60 [-webkit-text-security:disc]"
      />
      {text.trim() !== '' && (
        <div className="flex flex-col gap-2 font-mono text-[12px]">
          {parsed.vars.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Variables to import">
              {parsed.vars.map((v) => (
                <li
                  key={v.key}
                  className={`rounded border px-1.5 py-0.5 ${existing.has(v.key) ? 'border-warn/50 text-warn' : 'border-line text-fg'}`}
                  title={existing.has(v.key) ? 'Replaces the saved value' : 'New'}
                >
                  {v.key}
                  {existing.has(v.key) && ' · replaces'}
                </li>
              ))}
            </ul>
          )}
          {parsed.skipped.map((s) => (
            <p key={s.line} className="text-fail">
              line {s.line} skipped: {s.reason}
            </p>
          ))}
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={parsed.vars.length === 0}
              onClick={save}
            >
              Import {parsed.vars.length} variable{parsed.vars.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

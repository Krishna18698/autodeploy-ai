'use client';

import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimePanel } from '@/components/app/runtime-panel';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/confirm';
import { DiffView } from '@/components/ui/diff';
import { type LogLine, LogViewer } from '@/components/ui/log-viewer';
import { Empty, Panel, Skeleton } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status';
import { Stepper } from '@/components/ui/stepper';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { API_ORIGIN, ApiError, api, apiUrl, newIdempotencyKey, post } from '@/lib/api';
import { useApiStatus } from '@/lib/api-status';
import { ago, duration, shortSha } from '@/lib/format';
import {
  type DeploymentT,
  type RepairT,
  useDeployment,
  useEvents,
  useRepairs,
} from '@/lib/queries';
import { STATUS } from '@/lib/status';

export default function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const dep = useDeployment(id);
  const repairs = useRepairs(id);
  const [tab, setTab] = useState<'logs' | 'recovery' | 'timeline'>('logs');
  const d = dep.data;
  const live = d ? Boolean(STATUS[d.status].live) : false;
  const { lines, connected } = useLiveLogs(id, d, live);
  const qc = useQueryClient();
  const toast = useToast();
  const [cancel, setCancel] = useState(false);
  const router = useRouter();
  const [redeploying, setRedeploying] = useState(false);

  // Jump to the Recovery tab the first time a repair needs attention.
  const pendingRepair = repairs.data?.some((r) => r.status === 'awaiting_approval');
  const jumped = useRef(false);
  useEffect(() => {
    if (pendingRepair && !jumped.current) {
      jumped.current = true;
      setTab('recovery');
    }
  }, [pendingRepair]);

  if (dep.isLoading) return <Skeleton className="h-60" />;
  if (!d) return <Empty title="Deployment not found" />;
  const attempt = d.attempts.at(-1);

  // A failed build is never a dead end: build the project's latest commit again.
  const redeploy = async () => {
    if (!d) return;
    setRedeploying(true);
    try {
      const next = await post<{ id: string; number: number }>(
        `/api/v1/projects/${d.projectId}/deployments`,
        {},
        { idempotencyKey: newIdempotencyKey('redeploy') },
      );
      toast(`Deployment #${next.number} queued`, 'ok');
      router.push(`/deployments/${next.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start a deployment', 'fail');
    } finally {
      setRedeploying(false);
    }
  };

  const doCancel = async () => {
    try {
      await post(`/api/v1/deployments/${id}/cancel`);
      toast('Cancellation requested', 'ok');
      await qc.invalidateQueries({ queryKey: ['deployment', id] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not cancel', 'fail');
    } finally {
      setCancel(false);
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Link href={`/projects/${d.projectId}`} className="text-muted hover:text-fg">
              {d.projectSlug}
            </Link>
            <span className="text-muted">▸</span> #{d.number}
            <StatusPill status={d.status} size="md" />
          </span>
        }
        sub={
          <span className="font-mono text-[12px]">
            {d.kind} · {d.branch ?? '—'} @ {shortSha(d.commitSha)} · {d.trigger} ·{' '}
            {ago(d.createdAt)}
            {d.commitMessage && <span className="text-fg/70"> — {d.commitMessage}</span>}
          </span>
        }
        actions={
          <>
            {d.url && (
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[12px] text-run hover:underline"
              >
                {d.url.replace('https://', '')} ↗
              </a>
            )}
            {(live || d.status === 'AWAITING_APPROVAL') && (
              <Button variant="danger" size="sm" onClick={() => setCancel(true)}>
                Cancel
              </Button>
            )}
            {(d.status === 'FAILED' || d.status === 'CANCELED' || d.status === 'NEEDS_INPUT') && (
              <Button variant="primary" size="sm" loading={redeploying} onClick={redeploy}>
                Deploy again
              </Button>
            )}
          </>
        }
      />

      <div className="mb-5 rounded-[8px] border border-line bg-panel px-4 py-3">
        <Stepper status={d.status} />
        {d.errorSummary &&
          (d.status === 'FAILED' ||
            d.status === 'NEEDS_INPUT' ||
            d.status === 'BUILD_FAILED' ||
            d.status === 'RECOVERING') && (
            <p className="mt-3 font-mono text-[12px] text-fail">✗ {d.errorSummary}</p>
          )}
        {d.recoveredBy && (
          <p className="mt-3 font-mono text-[12px] text-ai">
            ⟲ recovered automatically (
            {d.recoveredBy === 'rule' ? 'deterministic rule' : 'AI patch, approved'})
          </p>
        )}
      </div>

      <Tabs
        id="deployment"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'logs', label: 'Logs' },
          { id: 'recovery', label: 'Recovery', badge: repairs.data?.length ?? 0 },
          { id: 'timeline', label: 'Timeline' },
        ]}
      />

      <div className="mt-4">
        {tab === 'logs' && (
          <div className="grid gap-4 lg:grid-cols-[1fr_260px] [&>*]:min-w-0">
            <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-[8px] border border-line bg-panel">
              <LogViewer lines={lines} live={live && connected} />
            </div>
            <aside className="flex flex-col gap-3">
              <RuntimePanel d={d} />
              <Panel title={`Attempt ${attempt?.attemptNo ?? '—'} / ${d.attempts.length}`}>
                {attempt ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[12px]">
                    <dt className="text-muted">executor</dt>
                    <dd>{attempt.executor}</dd>
                    <dt className="text-muted">node</dt>
                    <dd>{attempt.config.nodeVersion}</dd>
                    <dt className="text-muted">build</dt>
                    <dd className="truncate" title={attempt.config.buildCommand ?? ''}>
                      {attempt.config.buildCommand ?? '—'}
                    </dd>
                    <dt className="text-muted">output</dt>
                    <dd>{attempt.config.outputDir}/</dd>
                    <dt className="text-muted">took</dt>
                    <dd>{duration(attempt.durationMs)}</dd>
                    {attempt.errorCode && (
                      <>
                        <dt className="text-muted">error</dt>
                        <dd className="text-fail">{attempt.errorCode}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-[13px] text-muted">Not started.</p>
                )}
              </Panel>
              {d.attempts.length > 1 && (
                <Panel title="All attempts" pad={false}>
                  <ul className="divide-y divide-line font-mono text-[12px]">
                    {d.attempts.map((a) => (
                      <li key={a.id} className="flex items-center justify-between px-4 py-2">
                        <span>
                          #{a.attemptNo} · node {a.config.nodeVersion}
                        </span>
                        <span
                          className={
                            a.status === 'succeeded'
                              ? 'text-ok'
                              : a.status === 'failed'
                                ? 'text-fail'
                                : 'text-muted'
                          }
                        >
                          {a.errorCode ?? a.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
              {d.screenshotUrl && (
                <Panel title="Validated render" pad={false}>
                  {/* biome-ignore lint/performance/noImgElement: authenticated API image */}
                  <img
                    src={d.screenshotUrl.replace(/^https?:\/\/[^/]+/, '')}
                    alt="Headless Chromium screenshot of the deployed site"
                    className="w-full rounded-b-[8px]"
                  />
                </Panel>
              )}
            </aside>
          </div>
        )}
        {tab === 'recovery' && (
          <RecoveryPanel
            deployment={d}
            repairs={repairs.data ?? []}
            onChange={() => qc.invalidateQueries()}
          />
        )}
        {tab === 'timeline' && <Timeline id={id} />}
      </div>
      <Confirm
        open={cancel}
        title="Cancel this deployment?"
        body="Queued work stops now; a running build is stopped at its next heartbeat."
        confirmLabel="Cancel deployment"
        variant="danger"
        onConfirm={doCancel}
        onClose={() => setCancel(false)}
      />
    </>
  );
}

/**
 * Logs: while a deployment is in flight, Server-Sent Events (resumable via
 * Last-Event-ID, handled by EventSource); once it's finished, the persisted
 * log from object storage.
 */
function useLiveLogs(id: string, d: DeploymentT | undefined, live: boolean) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const qc = useQueryClient();
  const seen = useRef(new Set<string>());
  const known = Boolean(d);
  // A stream cut by an outage is given up by the browser; start again once it's back.
  const up = useApiStatus() === 'up';

  useEffect(() => {
    if (!known) return;
    seen.current = new Set();
    setLines([]);
    let es: EventSource | null = null;
    let cancelled = false;
    const add = (incoming: LogLine[]) => {
      const fresh = incoming.filter((l) => {
        const k = `${l.attemptNo}:${l.seq}`;
        if (seen.current.has(k)) return false;
        seen.current.add(k);
        return true;
      });
      if (fresh.length)
        setLines((prev) =>
          [...prev, ...fresh].sort((a, b) => a.attemptNo - b.attemptNo || a.seq - b.seq),
        );
    };
    // History first (covers finished attempts and anything older than the live buffer).
    api<{ lines: LogLine[] }>(`/api/v1/deployments/${id}/logs`)
      .then((r) => !cancelled && add(r.lines))
      .catch(() => {});
    if (live && up) {
      es = new EventSource(apiUrl(`/api/v1/deployments/${id}/stream`), {
        withCredentials: Boolean(API_ORIGIN),
      });
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.addEventListener('log', (e) => {
        const data = JSON.parse((e as MessageEvent).data) as {
          attemptNo: number;
          lines: Array<{ seq: number; text: string }>;
        };
        add(data.lines.map((l) => ({ ...l, attemptNo: data.attemptNo })));
      });
      es.addEventListener('status', () => {
        void qc.invalidateQueries({ queryKey: ['deployment', id] });
        void qc.invalidateQueries({ queryKey: ['repairs', id] });
        void qc.invalidateQueries({ queryKey: ['events', id] });
      });
    }
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id, known, live, up, qc]);

  return { lines, connected };
}

function RecoveryPanel({
  deployment,
  repairs,
  onChange,
}: {
  deployment: DeploymentT;
  repairs: RepairT[];
  onChange: () => void;
}) {
  if (repairs.length === 0) {
    return (
      <Empty
        title="No recovery needed"
        hint={
          deployment.status === 'FAILED'
            ? 'This failure had no safe automated fix.'
            : 'Every attempt so far built cleanly.'
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {repairs.map((r) => (
        <RepairCard key={r.id} repair={r} onChange={onChange} />
      ))}
    </div>
  );
}

function RepairCard({ repair: r, onChange }: { repair: RepairT; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (what: 'approve' | 'reject' | 'pull-request') => {
    setBusy(what);
    try {
      await post(`/api/v1/repairs/${r.id}/${what}`);
      toast(
        what === 'approve'
          ? 'Approved — publishing the validated build'
          : what === 'reject'
            ? 'Repair rejected'
            : 'Pull request queued',
        'ok',
      );
      onChange();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Action failed', 'fail');
    } finally {
      setBusy(null);
    }
  };
  const tone =
    r.status === 'awaiting_approval'
      ? 'border-ai/50'
      : r.status === 'failed' || r.status === 'rejected'
        ? 'border-fail/30'
        : 'border-line';
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-[10px] border ${tone} bg-panel`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${r.strategy === 'ai' ? 'bg-ai/15 text-ai' : 'bg-run/10 text-run'}`}
        >
          {r.strategy === 'ai' ? 'AI' : r.ruleId}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-medium">{r.title}</h3>
        <span className="font-mono text-[11px] text-muted">
          after attempt {r.attemptNo} · {r.errorCode} · {r.status.replace('_', ' ')}
        </span>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1.3fr]">
        <div className="flex flex-col gap-3 text-[13px]">
          {r.diagnosis ? (
            <div>
              <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">
                Diagnosis{' '}
                {r.diagnosis.provider &&
                  `· ${r.diagnosis.provider}${r.diagnosis.model ? ` / ${r.diagnosis.model}` : ''}`}
              </div>
              <p className="text-fg">{r.diagnosis.summary}</p>
              <p className="mt-1 text-muted">{r.diagnosis.cause}</p>
              {r.diagnosis.filesRead.length > 0 && (
                <p className="mt-1 font-mono text-[11px] text-muted">
                  read: {r.diagnosis.filesRead.join(', ')}
                </p>
              )}
            </div>
          ) : null}
          <p className="text-muted">{r.explanation}</p>
          {r.configChanges.length > 0 && (
            <ul className="font-mono text-[12px]">
              {r.configChanges.map((c) => (
                <li key={c.field}>
                  <span className="text-muted">{c.field}</span>{' '}
                  <span className="text-fail line-through">{String(c.from ?? '∅')}</span> →{' '}
                  <span className="text-ok">{String(c.to ?? '∅')}</span>
                </li>
              ))}
            </ul>
          )}
          {r.policy && (
            <ul className="flex flex-col gap-1 font-mono text-[12px]">
              <li className={r.policy.allowed ? 'text-ok' : 'text-fail'}>
                {r.policy.allowed
                  ? '✓ within patch policy (scope, size, no secrets/CI/scripts)'
                  : '✗ blocked by patch policy'}
              </li>
              {r.policy.violations.map((v) => (
                <li key={`${v.rule}${v.path}`} className="text-fail">
                  ✗ {v.path} {v.detail}
                </li>
              ))}
              {r.policy.approvalReasons.map((a) => (
                <li key={a} className="text-warn">
                  ⚠ needs approval: {a}
                </li>
              ))}
            </ul>
          )}
          {r.prUrl && (
            <a
              href={r.prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12px] text-run hover:underline"
            >
              Pull request ↗
            </a>
          )}
          {r.status === 'awaiting_approval' && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="ai" loading={busy === 'approve'} onClick={() => act('approve')}>
                Approve & deploy
              </Button>
              <Button loading={busy === 'pull-request'} onClick={() => act('pull-request')}>
                Open PR
              </Button>
              <Button variant="ghost" loading={busy === 'reject'} onClick={() => act('reject')}>
                Reject
              </Button>
            </div>
          )}
        </div>
        <div>
          {r.diff ? (
            <DiffView diff={r.diff} />
          ) : (
            <div className="grid h-full min-h-24 place-items-center rounded-md border border-dashed border-line font-mono text-[12px] text-muted">
              configuration-only repair · no source change
            </div>
          )}
        </div>
      </div>
    </motion.section>
  );
}

function Timeline({ id }: { id: string }) {
  const events = useEvents(id);
  const items = useMemo(() => events.data ?? [], [events.data]);
  if (!events.data) return <Skeleton className="h-40" />;
  return (
    <ol className="relative ml-2 border-l border-line pl-6">
      {items.map((e, i) => {
        const title =
          e.type === 'status_changed'
            ? `${e.fromStatus} → ${e.toStatus}`
            : e.type.replaceAll('_', ' ');
        const tone =
          e.toStatus === 'FAILED' || e.toStatus === 'BUILD_FAILED'
            ? 'bg-fail'
            : e.toStatus === 'ACTIVE' || e.toStatus === 'READY'
              ? 'bg-ok'
              : e.type.startsWith('repair')
                ? 'bg-ai'
                : 'bg-run';
        const details = Object.entries(e.payload).filter(
          ([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0),
        );
        return (
          <motion.li
            key={e.id}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.4) }}
            className="relative mb-4"
          >
            <span
              aria-hidden
              className={`absolute -left-[29px] top-1.5 size-2.5 rounded-full ring-4 ring-bg ${tone}`}
            />
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[11px] text-muted">
                {new Date(e.createdAt).toLocaleTimeString()}
              </span>
              <span className="text-[13px] text-fg">{title}</span>
            </div>
            {details.length > 0 && (
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {details
                  .slice(0, 6)
                  .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                  .join(' · ')
                  .slice(0, 300)}
              </p>
            )}
          </motion.li>
        );
      })}
    </ol>
  );
}

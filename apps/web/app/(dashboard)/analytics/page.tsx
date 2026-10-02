'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/app/shell';
import { BarList, LineChart, StackedColumns } from '@/components/ui/charts';
import { Panel, Skeleton, Stat } from '@/components/ui/panel';
import { duration } from '@/lib/format';
import { useAnalytics } from '@/lib/queries';

const RANGES = [7, 30, 90];

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const a = useAnalytics(days);
  const d = a.data;
  const fmtDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = d?.totals;
  return (
    <>
      <PageHeader
        title="Analytics"
        sub="Projected from the deployment event stream by the analytics consumer."
      />
      {/* Filters: one row above everything they scope. */}
      <fieldset className="mb-5 flex gap-1.5 m-0 border-0 p-0">
        <legend className="sr-only">Date range</legend>
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={days === r}
            onClick={() => setDays(r)}
            className={`rounded-full border px-3 py-1 text-[12px] ${days === r ? 'border-run/50 bg-run/10 text-fg' : 'border-line text-muted hover:text-fg'}`}
          >
            Last {r} days
          </button>
        ))}
      </fieldset>
      {!d ? (
        <Skeleton className="h-80" />
      ) : (
        <div
          className={`flex flex-col gap-6 transition-opacity ${a.isFetching ? 'opacity-80' : ''}`}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Deployments"
              value={t?.deployments.toLocaleString()}
              sub={`${t?.succeeded} succeeded · ${t?.failed} failed`}
            />
            <Stat
              label="Success rate"
              value={t?.deployments ? `${Math.round((t.succeeded / t.deployments) * 100)}%` : '—'}
            />
            <Stat
              label="Build time p95"
              value={duration(d.buildMs.p95)}
              sub={`p50 ${duration(d.buildMs.p50)}`}
            />
            <Stat
              label="Queue wait p95"
              value={duration(d.queueWaitMs.p95)}
              sub={`p50 ${duration(d.queueWaitMs.p50)}`}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Panel title="Deployments per day">
              <StackedColumns
                ariaLabel="Deployments per day, split into succeeded and failed"
                data={d.daily.map((x) => ({
                  day: x.day,
                  succeeded: x.succeeded,
                  failed: x.failed,
                }))}
                xKey="day"
                formatX={fmtDay}
                series={[
                  { key: 'succeeded', label: 'Succeeded', color: 'var(--color-chart-1)' },
                  { key: 'failed', label: 'Failed', color: 'var(--color-chart-fail)' },
                ]}
              />
            </Panel>
            <Panel title="Build time p95 per day">
              <LineChart
                data={d.daily}
                xKey="day"
                yKey="p95BuildMs"
                label="p95 build time"
                formatY={(v) => duration(v)}
                formatX={fmtDay}
              />
            </Panel>
          </div>
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <Panel title="How failures ended">
              <BarList
                items={[
                  { label: 'fixed by rule', value: t?.recoveredByRule ?? 0 },
                  { label: 'fixed by AI', value: t?.recoveredByAi ?? 0 },
                  { label: 'escalated', value: t?.escalated ?? 0 },
                ]}
              />
            </Panel>
            <Panel title="Top error signatures">
              <BarList items={d.topSignatures.map((s) => ({ label: s.code, value: s.count }))} />
            </Panel>
            <Panel title="Event consumers">
              <table className="w-full text-left text-[12px]">
                <thead className="font-mono text-[11px] text-muted">
                  <tr>
                    <th className="pb-2 font-normal">group</th>
                    <th className="pb-2 text-right font-normal">lag</th>
                    <th className="pb-2 text-right font-normal">DLQ</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {d.consumers.map((c) => (
                    <tr key={c.group} className="border-t border-line">
                      <td className="py-1.5">{c.group}</td>
                      <td className="py-1.5 text-right">{c.lag ?? '—'}</td>
                      <td className={`py-1.5 text-right ${c.dlq ? 'text-fail' : ''}`}>{c.dlq}</td>
                    </tr>
                  ))}
                  {d.consumers.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-3 text-muted">
                        No consumer metrics yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </div>
          <Panel title="AI usage">
            {d.ai.length === 0 ? (
              <p className="text-[13px] text-muted">
                No model calls in this range — every failure was handled by rules or escalated.
              </p>
            ) : (
              <table className="w-full text-left text-[12px]">
                <thead className="font-mono text-[11px] text-muted">
                  <tr>
                    <th className="pb-2 font-normal">provider</th>
                    <th className="pb-2 text-right font-normal">calls</th>
                    <th className="pb-2 text-right font-normal">failures</th>
                    <th className="pb-2 text-right font-normal">avg latency</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {d.ai.map((r) => (
                    <tr key={r.provider} className="border-t border-line">
                      <td className="py-1.5">{r.provider}</td>
                      <td className="py-1.5 text-right">{r.calls}</td>
                      <td className="py-1.5 text-right">{r.failures}</td>
                      <td className="py-1.5 text-right">{duration(r.avgLatencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

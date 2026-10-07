'use client';

import type { GitHubRepos } from '@autodeploy/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { Panel } from '@/components/ui/panel';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

type Repos = z.infer<typeof GitHubRepos>;

/**
 * Repositories the AutoDeploy GitHub App can see for this user (their own
 * installation, or one their org claimed). Picking one fills the import form.
 */
export function RepoPicker({
  selected,
  onPick,
}: {
  selected: string;
  onPick: (url: string) => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['github-repos'],
    queryFn: () => api<Repos>('/api/v1/github/repos'),
    staleTime: 60_000,
  });
  const [q, setQ] = useState('');
  const shown = useMemo(
    () => (data?.repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );

  if (isError || (data && !data.configured)) return null;

  const install = data?.installUrl && (
    <a
      href={data.installUrl}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[11px] text-run hover:underline"
    >
      Add repositories on GitHub ↗
    </a>
  );

  return (
    <Panel
      title={
        data?.accounts.length
          ? `Your repositories · ${data.accounts.join(', ')}`
          : 'Your repositories'
      }
      action={install}
      pad={false}
      className="mb-5"
    >
      {isLoading ? (
        <div className="space-y-2 p-4" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-raised/60" />
          ))}
        </div>
      ) : !data?.repos.length ? (
        <p className="px-4 py-5 text-[13px] text-muted">
          The AutoDeploy app can’t see any of your repositories yet. Give it access on GitHub, then
          come back here.
        </p>
      ) : (
        <>
          <div className="border-b border-line p-3">
            <label className="sr-only" htmlFor="repo-search">
              Search your repositories
            </label>
            <input
              id="repo-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your repositories…"
              className="h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-[13px] outline-none placeholder:text-muted/60 focus:border-run/60"
            />
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
            {shown.map((r) => {
              const active = selected === r.url;
              if (r.projectId)
                return (
                  <li key={r.fullName}>
                    <Link
                      href={`/projects/${r.projectId}`}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-raised/60"
                    >
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full border border-ok/60 bg-ok/40"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">
                        {r.fullName}
                      </span>
                      <span className="font-mono text-[11px] text-ok">Open project →</span>
                    </Link>
                  </li>
                );
              return (
                <li key={r.fullName}>
                  <button
                    type="button"
                    onClick={() => onPick(r.url)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-raised/60 ${active ? 'bg-raised/70' : ''}`}
                  >
                    <span
                      aria-hidden
                      className={`size-2.5 shrink-0 rounded-full border ${active ? 'border-run bg-run' : 'border-muted/60'}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.fullName}</span>
                    {r.private && (
                      <span className="rounded border border-line px-1.5 font-mono text-[10px] text-muted">
                        private
                      </span>
                    )}
                    {r.imported && (
                      <span className="rounded border border-ok/40 px-1.5 font-mono text-[10px] text-ok">
                        imported
                      </span>
                    )}
                    <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-muted sm:block">
                      {r.pushedAt ? ago(r.pushedAt) : ''}
                    </span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-4 py-4 text-[13px] text-muted">No repository matches “{q}”.</li>
            )}
          </ul>
        </>
      )}
    </Panel>
  );
}

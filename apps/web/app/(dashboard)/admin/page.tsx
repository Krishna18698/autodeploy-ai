'use client';

import type { AdminSite } from '@autodeploy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/confirm';
import { Empty, Panel } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, post } from '@/lib/api';
import { ago } from '@/lib/format';
import { useAdminSites, useMe } from '@/lib/queries';

type Site = z.infer<typeof AdminSite>;
type Action =
  | { kind: 'takedown' | 'restore'; site: Site }
  | { kind: 'suspend' | 'unsuspend'; site: Site };

const COPY: Record<
  Action['kind'],
  { title: string; confirm: string; done: string; reason: boolean }
> = {
  takedown: {
    title: 'Take this site down?',
    confirm: 'Take down',
    done: 'Taken down. Its addresses show the notice within a minute.',
    reason: true,
  },
  restore: { title: 'Put this site back?', confirm: 'Restore', done: 'Restored.', reason: false },
  suspend: {
    title: 'Suspend this account?',
    confirm: 'Suspend account',
    done: 'Suspended. Its sites show the notice within a minute.',
    reason: true,
  },
  unsuspend: {
    title: 'Lift the suspension?',
    confirm: 'Lift suspension',
    done: 'Lifted. Sites taken down on their own stay down.',
    reason: false,
  },
};

export default function AdminPage() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [down, setDown] = useState(false);
  const sites = useAdminSites(down ? '' : search, down);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  if (me.data && !me.data.user.platformAdmin)
    return <Empty title="Platform admins only" hint="This page is for handling abuse reports." />;

  const run = async () => {
    if (!action) return;
    const { kind, site } = action;
    const path =
      kind === 'takedown' || kind === 'restore'
        ? `/api/v1/admin/sites/${site.projectId}/${kind}`
        : `/api/v1/admin/orgs/${site.org.id}/${kind}`;
    setBusy(true);
    try {
      await post(path, COPY[kind].reason ? { reason } : undefined);
      toast(COPY[kind].done, 'ok');
      setAction(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['admin-sites'] });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Admin"
        sub="Abuse reports: find a site, take it down or suspend its account. Owners are emailed the reason."
      />
      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          setDown(false);
          setSearch(q.trim());
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Site address, slug, account, or owner login/email"
          aria-label="Find a site"
          className="h-9 rounded-md border border-line bg-bg px-3 text-[13px] text-fg outline-none focus:border-run/60 sm:flex-1"
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" className="flex-1 sm:flex-none">
            Find
          </Button>
          <Button
            type="button"
            variant={down ? 'secondary' : 'ghost'}
            className="flex-1 sm:flex-none"
            onClick={() => setDown((d) => !d)}
            aria-pressed={down}
          >
            Taken down
          </Button>
        </div>
      </form>

      <Panel pad={false}>
        {!down && !search ? (
          <Empty
            title="Find a site"
            hint="Paste the address from the report (any of its addresses works), or an owner's login or email."
          />
        ) : sites.isLoading ? (
          <p className="p-4 text-[13px] text-muted">Searching…</p>
        ) : !sites.data?.length ? (
          <Empty title={down ? 'Nothing is taken down' : 'No site matches'} />
        ) : (
          <ul className="divide-y divide-line">
            {sites.data.map((s) => (
              <li
                key={s.projectId}
                className="flex flex-col gap-3 p-4 text-[13px] sm:flex-row sm:items-start"
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-fg hover:underline"
                  >
                    {s.url.replace('https://', '')}
                  </a>
                  <p className="mt-1 text-muted [overflow-wrap:anywhere]">
                    {s.repo} · created {ago(s.createdAt)} · account {s.org.name}
                    {s.owners.length > 0 &&
                      ` · ${s.owners.map((o) => (o.email ? `${o.login} <${o.email}>` : o.login)).join(', ')}`}
                  </p>
                  {s.org.suspendedAt ? (
                    <p className="mt-1 text-fail">
                      Account suspended {ago(s.org.suspendedAt)}: {s.org.suspendedReason}
                    </p>
                  ) : s.takenDownAt ? (
                    <p className="mt-1 text-fail">
                      Taken down {ago(s.takenDownAt)}: {s.takenDownReason}
                    </p>
                  ) : (
                    <p className="mt-1 text-muted">{s.live ? 'Live' : 'Not deployed'}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.org.suspendedAt ? (
                    <Button size="sm" onClick={() => setAction({ kind: 'unsuspend', site: s })}>
                      Lift suspension
                    </Button>
                  ) : (
                    <>
                      {s.takenDownAt ? (
                        <Button size="sm" onClick={() => setAction({ kind: 'restore', site: s })}>
                          Restore
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setAction({ kind: 'takedown', site: s })}
                        >
                          Take down
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setAction({ kind: 'suspend', site: s })}
                      >
                        Suspend account
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Confirm
        open={action !== null}
        title={action ? COPY[action.kind].title : ''}
        confirmLabel={action ? COPY[action.kind].confirm : ''}
        variant={action?.kind === 'takedown' || action?.kind === 'suspend' ? 'danger' : 'primary'}
        loading={busy}
        onClose={() => setAction(null)}
        onConfirm={() => {
          if (action && COPY[action.kind].reason && reason.trim().length < 3) {
            toast('Give a reason: the owner is emailed it.', 'fail');
            return;
          }
          void run();
        }}
        body={
          action && (
            <>
              <p className="break-all">
                {action.kind === 'suspend' || action.kind === 'unsuspend'
                  ? `Account ${action.site.org.name}: every one of its sites.`
                  : action.site.url}
              </p>
              {COPY[action.kind].reason && (
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Reason (emailed to the owner and kept in their audit log)"
                  aria-label="Reason"
                  className="mt-3 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-fg outline-none focus:border-run/60"
                />
              )}
            </>
          )
        }
      />
    </>
  );
}

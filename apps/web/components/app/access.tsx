'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, post } from '@/lib/api';
import { type MeT, useMe } from '@/lib/queries';

// Portfolio mode: anyone signs in and looks around the read-only demo org;
// their own account deploys once a platform admin approves it.

type Org = MeT['orgs'][number];

/** The person's own account (the one they own that isn't the demo). */
export const ownOrg = (me: MeT | undefined): Org | undefined =>
  me?.orgs.find((o) => !o.demo && o.role === 'owner');

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Above every dashboard page: what the demo is, or that deploying waits for approval. */
export function PortfolioBanner() {
  const me = useMe();
  const qc = useQueryClient();
  const m = me.data;
  if (!m) return null;
  const own = ownOrg(m);
  const switchTo = async (orgId: string) => {
    await post('/api/v1/session/org', { orgId });
    await qc.invalidateQueries();
  };
  if (m.org.demo === true && m.org.role === 'viewer')
    return (
      <Note>
        <span className="min-w-0 flex-1">
          <strong className="font-medium">You’re looking at the AutoDeploy demo.</strong> Real
          deploys, logs and self-heals, read-only.
        </span>
        {own?.canDeploy ? (
          <Button size="sm" variant="primary" onClick={() => switchTo(own.id)}>
            Go to your account
          </Button>
        ) : own?.accessRequestedAt ? (
          <span className="text-muted">Access requested {shortDate(own.accessRequestedAt)}</span>
        ) : (
          <Link
            href="/projects/new"
            className="rounded-lg bg-fg px-3 py-1.5 text-[13px] font-medium text-bg hover:bg-fg/90"
          >
            Deploy your own
          </Link>
        )}
      </Note>
    );
  if (!m.org.demo && m.org.canDeploy === false && m.org.role === 'owner' && m.org.id === own?.id)
    return (
      <Note>
        <span className="min-w-0 flex-1">
          {own.accessRequestedAt
            ? `You asked to deploy on ${shortDate(own.accessRequestedAt)}: you’ll get an email once you can.`
            : 'Deploying your own repositories needs approval while AutoDeploy is a portfolio project.'}
        </span>
        {!own.accessRequestedAt && (
          <Link href="/projects/new" className="font-medium text-run hover:underline">
            Ask for access →
          </Link>
        )}
      </Note>
    );
  return null;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-run/25 bg-run/5 px-4 py-3 text-[13px]">
      {children}
    </div>
  );
}

/** Instead of the import form, until the account may deploy. */
export function RequestAccess() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const own = ownOrg(me.data);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/api/v1/access-requests', { note: note.trim() });
      toast('Asked. You’ll get an email once you can deploy.', 'ok');
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not send it', 'fail');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Deploying needs approval">
      <div className="flex max-w-2xl flex-col gap-4 text-[13px] leading-relaxed text-muted">
        <p>
          AutoDeploy is a portfolio project running on one free server, so deploying your own
          repositories is by approval. Meanwhile the demo shows everything it does with real
          deploys: builds with live logs, failures fixed by rules or AI, instant rollbacks.
        </p>
        {own?.canDeploy ? (
          <p className="text-fg">
            Your own account can deploy: switch to {own.name} from the organisation menu.
          </p>
        ) : own?.accessRequestedAt ? (
          <p className="text-fg">
            You asked on {shortDate(own.accessRequestedAt)}. You’ll get an email once you can
            deploy.
          </p>
        ) : (
          <form onSubmit={send} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-[12px]">
              What would you like to deploy? (optional)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="A link to the repository, or a sentence about it"
                className="rounded-lg border border-white/8 bg-white/4 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted/60 focus:border-run/60"
              />
            </label>
            <span>
              <Button type="submit" variant="primary" loading={busy}>
                Ask for access
              </Button>
            </span>
          </form>
        )}
      </div>
    </Panel>
  );
}

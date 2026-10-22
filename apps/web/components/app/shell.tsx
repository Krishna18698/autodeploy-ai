'use client';

import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { Kbd } from '@/components/ui/panel';
import { useToast } from '@/components/ui/toast';
import { ApiError, post } from '@/lib/api';
import { useAllRepairs, useMe, useMyInvitations, useQuota } from '@/lib/queries';
import { CommandPalette } from './command-palette';

const NAV = [
  // Line icons on a 20px grid.
  {
    href: '/overview',
    label: 'Overview',
    icon: 'M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z',
  },
  {
    href: '/projects',
    label: 'Projects',
    icon: 'M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6v.5',
  },
  { href: '/deployments', label: 'Deployments', icon: 'M10 16.5V4M5 9l5-5 5 5' },
  { href: '/recovery', label: 'Recovery', icon: 'M4 10a6 6 0 1 0 2-4.5M4 3.5v3h3' },
  { href: '/analytics', label: 'Analytics', icon: 'M4 16.5V11M8 16.5V7M12 16.5V9.5M16 16.5V4' },
  {
    href: '/settings',
    label: 'Settings',
    icon: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4',
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const awaiting = useAllRepairs('awaiting_approval');
  const quota = useQuota();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.error, router, pathname]);

  if (!me.data) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <span className="font-mono text-[12px] text-muted">
          {me.error && !(me.error instanceof ApiError && me.error.status === 401)
            ? 'API unreachable — is it running?'
            : 'Loading…'}
        </span>
      </div>
    );
  }

  const switchOrg = async (orgId: string) => {
    await post('/api/v1/session/org', { orgId });
    await qc.invalidateQueries();
  };
  const logout = async () => {
    await post('/auth/logout');
    qc.clear();
    router.replace('/login');
  };
  const pending = awaiting.data?.length ?? 0;

  return (
    <div className="min-h-dvh bg-bg lg:grid lg:grid-cols-[220px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 z-30 flex flex-col border-b border-white/6 bg-[#0b0c0e]/90 backdrop-blur lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-14 items-center justify-between px-4">
          <Link
            href="/overview"
            className="flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          >
            <Logo />
          </Link>
          <button
            type="button"
            className="-mr-2 grid size-10 place-items-center rounded-md text-muted hover:text-fg lg:hidden"
            aria-label={menu ? 'Close menu' : 'Open menu'}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
              {menu ? (
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" />
              ) : (
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" />
              )}
            </svg>
          </button>
        </div>
        <nav aria-label="Main" className={`${menu ? 'block' : 'hidden'} px-2 pb-3 lg:block`}>
          <ul className="flex flex-col gap-0.5">
            {NAV.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    onClick={() => setMenu(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors pointer-coarse:py-2.5 ${active ? 'text-fg' : 'text-muted hover:bg-white/4 hover:text-fg'}`}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-0 rounded-lg bg-white/6"
                        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      />
                    )}
                    <svg viewBox="0 0 20 20" aria-hidden className="relative size-4 shrink-0">
                      <path
                        d={n.icon}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="relative">{n.label}</span>
                    {n.href === '/recovery' && pending > 0 && (
                      <span className="relative ml-auto rounded-full bg-ai/20 px-1.5 font-mono text-[10px] text-ai">
                        {pending}
                        <span className="sr-only"> awaiting approval</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          {/* Phones: the top bar is hidden, so its org switcher and sign-out live here. */}
          <div className="mt-3 flex flex-col gap-2 border-t border-white/6 px-3 pt-3 lg:hidden">
            <label className="text-[12px] text-muted" htmlFor="org-mobile">
              Organisation
            </label>
            <select
              id="org-mobile"
              value={me.data.org.id}
              onChange={(e) => switchOrg(e.target.value)}
              className="h-10 rounded-lg border border-white/8 bg-white/4 px-2 text-[13px] text-fg outline-none focus:border-run/60"
            >
              {me.data.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.role}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-between py-1 text-[13px] text-muted">
              <span>{me.data.user.login}</span>
              <button type="button" onClick={logout} className="py-2 hover:text-fg">
                Sign out
              </button>
            </div>
          </div>
        </nav>
        <div className="mt-auto hidden border-t border-white/6 px-4 py-3 text-[12px] text-muted lg:block">
          {quota.data && (
            <div className="mb-3">
              <div className="flex justify-between">
                <span>Deploys today</span>
                <span className="tabular-nums">
                  {quota.data.deploysToday}/{quota.data.dailyLimit}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/6">
                <div
                  className="h-full rounded-full bg-run/80"
                  style={{
                    width: `${Math.min(100, (quota.data.deploysToday / Math.max(1, quota.data.dailyLimit)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          <span className="flex items-center gap-1.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> to jump
          </span>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 hidden h-14 items-center justify-end gap-3 border-b border-white/6 bg-bg/80 px-6 backdrop-blur lg:flex">
          <label className="sr-only" htmlFor="org">
            Organisation
          </label>
          <select
            id="org"
            value={me.data.org.id}
            onChange={(e) => switchOrg(e.target.value)}
            className="h-8 rounded-lg border border-white/8 bg-white/4 px-2 text-[13px] text-fg outline-none focus:border-run/60"
          >
            {me.data.orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.role}
              </option>
            ))}
          </select>
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-full bg-gradient-to-b from-white/20 to-white/5 text-[11px] font-medium text-fg"
            >
              {me.data.user.login.slice(0, 2).toUpperCase()}
            </span>
            {me.data.user.login}
          </span>
          <button type="button" onClick={logout} className="text-[13px] text-muted hover:text-fg">
            Sign out
          </button>
        </header>
        {/* A CSS fade, restarted per page by the key. It used to be a motion
            exit/enter pair (AnimatePresence mode="wait"), whose exit could stall
            on client-side navigation and leave the new page at opacity 0: a
            blank screen. A CSS animation always ends visible. */}
        <main
          id="main"
          key={pathname}
          className="page-in mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8"
        >
          <Invitations />
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

/** Teams people have been invited to: they join only by accepting here. */
function Invitations() {
  const invites = useMyInvitations();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!invites.data?.length) return null;
  const answer = async (id: string, choice: 'accept' | 'decline', orgName: string) => {
    setBusy(id);
    try {
      await post(`/api/v1/invitations/${id}/${choice}`);
      if (choice === 'accept')
        toast(`You joined ${orgName}. Switch to it from the organisation menu.`, 'ok');
      await qc.invalidateQueries({ queryKey: ['invites'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Invitations" className="mb-6 flex flex-col gap-2">
      {invites.data.map((i) => (
        <div
          key={i.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-run/25 bg-run/5 px-4 py-3 text-[13px]"
        >
          <span className="min-w-0 flex-1">
            {i.invitedBy ? <strong className="font-medium">{i.invitedBy}</strong> : 'Someone'}{' '}
            invited you to join <strong className="font-medium">{i.org.name}</strong> as {i.role}.
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === i.id}
              onClick={() => answer(i.id, 'decline', i.org.name)}
            >
              Decline
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === i.id}
              onClick={() => answer(i.id, 'accept', i.org.name)}
            >
              Accept
            </Button>
          </span>
        </div>
      ))}
    </section>
  );
}

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
        {sub && <div className="mt-1 text-[13px] text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

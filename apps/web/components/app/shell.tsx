'use client';

import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Kbd } from '@/components/ui/panel';
import { ApiError, post } from '@/lib/api';
import { useAllRepairs, useMe, useQuota } from '@/lib/queries';
import { CommandPalette } from './command-palette';

const NAV = [
  { href: '/overview', label: 'Overview', glyph: '▣' },
  { href: '/projects', label: 'Projects', glyph: '▤' },
  { href: '/deployments', label: 'Deployments', glyph: '▶' },
  { href: '/recovery', label: 'Recovery', glyph: '⟲' },
  { href: '/analytics', label: 'Analytics', glyph: '◔' },
  { href: '/settings', label: 'Settings', glyph: '⚙' },
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
      <aside className="sticky top-0 z-30 flex flex-col border-b border-line bg-panel/80 backdrop-blur lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-14 items-center justify-between px-4">
          <Link
            href="/overview"
            className="flex items-center gap-2 text-[13px] font-semibold tracking-tight"
          >
            <span
              aria-hidden
              className="grid size-5 place-items-center rounded-[5px] bg-run text-[11px] text-bg"
            >
              ◆
            </span>
            AutoDeploy
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
                    className={`relative flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${active ? 'text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'}`}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-0 rounded-md bg-raised"
                        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      />
                    )}
                    <span aria-hidden className="relative w-4 text-center font-mono text-[12px]">
                      {n.glyph}
                    </span>
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
        </nav>
        <div className="mt-auto hidden border-t border-line px-4 py-3 font-mono text-[11px] text-muted lg:block">
          {quota.data && (
            <div className="mb-2">
              deploys today {quota.data.deploysToday}/{quota.data.dailyLimit}
              <div className="mt-1 h-1 overflow-hidden rounded bg-raised">
                <div
                  className="h-full bg-run/70"
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
        <header className="sticky top-0 z-20 hidden h-14 items-center justify-end gap-3 border-b border-line bg-bg/80 px-6 backdrop-blur lg:flex">
          <label className="sr-only" htmlFor="org">
            Organisation
          </label>
          <select
            id="org"
            value={me.data.org.id}
            onChange={(e) => switchOrg(e.target.value)}
            className="h-8 rounded-md border border-line bg-panel px-2 text-[13px] text-fg outline-none focus:border-run/60"
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
              className="grid size-7 place-items-center rounded-full border border-line bg-raised font-mono text-[11px] text-fg"
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
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
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
        <h1 className="truncate text-[22px] font-semibold tracking-tight">{title}</h1>
        {sub && <div className="mt-1 text-[13px] text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

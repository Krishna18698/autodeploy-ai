'use client';

import { useApiStatus, useOnline } from '@/lib/api-status';

// What people see while AutoDeploy's server (the VM) is down: plainly that it
// is, what still works, and that the page comes back on its own.

const COPY = {
  dashboard: {
    title: 'AutoDeploy is down right now',
    body: 'Deploying and changes are paused, and this page reconnects by itself. Static sites stay online; server-rendered sites come back with it.',
  },
  signin: {
    title: 'AutoDeploy is down right now',
    body: 'Signing in is paused, and this page reconnects by itself. Sites hosted here stay online.',
  },
  offline: {
    title: 'You’re offline',
    body: 'Changes are paused until your connection is back.',
  },
};

export function OutageBanner({ where }: { where: 'dashboard' | 'signin' }) {
  const status = useApiStatus();
  const online = useOnline();
  if (status === 'up' && online) return null;
  return <OutageNotice kind={online ? where : 'offline'} />;
}

/**
 * While the API is down, every button and field inside is paused (a disabled
 * fieldset disables them all). Links stay usable; one that leads to the API
 * can opt out with `group-disabled/paused:pointer-events-none`.
 */
export function PausedWhenDown({ children }: { children: React.ReactNode }) {
  const down = useApiStatus() === 'down';
  return (
    <fieldset disabled={down} className="group/paused m-0 min-w-0 border-0 p-0">
      {children}
    </fieldset>
  );
}

export function OutageNotice({ kind }: { kind: keyof typeof COPY }) {
  const c = COPY[kind];
  return (
    <div
      role="status"
      className="flex gap-3 rounded-xl border border-warn/30 bg-warn/8 px-4 py-3 text-[13px] leading-5"
    >
      <span aria-hidden className="relative mt-1.5 flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn/60 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-warn" />
      </span>
      <span className="min-w-0">
        <strong className="font-medium text-fg">{c.title}</strong>
        <span className="block text-fg/75">{c.body}</span>
      </span>
    </div>
  );
}

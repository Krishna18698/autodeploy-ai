'use client';

import { useSyncExternalStore } from 'react';

// Whether the API answers. The dashboard's pages come from Vercel and keep
// loading when the VM is down; this lets them say so plainly and pause
// actions, then notices when the API is back and reloads the data.
//
// Every API call reports in (lib/api.ts). While anything shows the status, the
// API's readiness check is asked every minute, and every 10 seconds while down.

export type ApiStatus = 'up' | 'down';

let status: ApiStatus = 'up';
const listeners = new Set<() => void>();
let onBack: (() => void) | null = null;

function set(next: ApiStatus) {
  if (next === status) return;
  const recovered = status === 'down' && next === 'up';
  status = next;
  for (const l of listeners) l();
  schedule();
  if (recovered) onBack?.();
}

export const reportReachable = () => set('up');
export const reportUnreachable = () => set('down');
/** Called once the API answers again after an outage (the dashboard refetches). */
export const setOnBack = (fn: (() => void) | null) => {
  onBack = fn;
};

// ---- the readiness check, shared by everything that shows the status

const UP_EVERY_MS = 60_000;
const DOWN_EVERY_MS = 10_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let checkUrl = '';

async function check() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return set('down');
  try {
    const r = await fetch(checkUrl, { cache: 'no-store', credentials: 'omit' });
    set(r.ok ? 'up' : 'down');
  } catch {
    set('down');
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!listeners.size || !checkUrl) return;
  timer = setTimeout(
    async () => {
      await check();
      schedule();
    },
    status === 'down' ? DOWN_EVERY_MS : UP_EVERY_MS,
  );
}

const wake = () => void check().then(schedule);

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    document.addEventListener('visibilitychange', onVisible);
    wake();
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', wake);
      document.removeEventListener('visibilitychange', onVisible);
      schedule();
    }
  };
}
const onVisible = () => {
  if (document.visibilityState === 'visible') wake();
};

/** Where to ask; set by lib/api.ts (the API's own readiness check). */
export function setCheckUrl(url: string) {
  checkUrl = url;
}

/** The API's status; showing it keeps the readiness check running. */
export function useApiStatus(): ApiStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => 'up',
  );
}

/** Online as far as the browser knows (the message differs: their connection, not ours). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener('online', l);
      window.addEventListener('offline', l);
      return () => {
        window.removeEventListener('online', l);
        window.removeEventListener('offline', l);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

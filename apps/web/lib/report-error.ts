// Sends dashboard crashes to the API (which forwards them to Sentry), so a
// blank page is no longer invisible to us. Best effort: never throws, sends
// each distinct error once per page load, at most 5 per load.

import { API_ORIGIN, apiUrl } from './api';

type Kind = 'error' | 'unhandledrejection' | 'boundary';
const sent = new Set<string>();

export function reportClientError(kind: Kind, err: unknown, digest?: string): void {
  if (typeof window === 'undefined') return;
  const e = err instanceof Error ? err : new Error(String(err));
  const key = `${kind}:${e.name}:${e.message}`;
  if (sent.has(key) || sent.size >= 5) return;
  sent.add(key);
  const body = JSON.stringify({
    kind,
    name: e.name.slice(0, 200),
    message: e.message.slice(0, 1000) || '(no message)',
    stack: e.stack?.slice(0, 8000),
    path: `${location.pathname}${location.search}`.slice(0, 500),
    ...(digest && { digest: digest.slice(0, 100) }),
  });
  fetch(apiUrl('/api/v1/client-errors'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    // The session, when there is one, names who hit it.
    credentials: API_ORIGIN ? 'include' : 'same-origin',
  }).catch(() => {});
}

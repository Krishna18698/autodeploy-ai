'use client';

import type { Problem } from '@autodeploy/contracts';
import { reportReachable, reportUnreachable, setCheckUrl } from './api-status';

// Thin fetch wrapper: cookies, CSRF header on writes, and RFC 9457 problem
// responses turned into typed errors the UI can show. An API that doesn't
// answer at all (the VM is down) is reported to lib/api-status.

/** The API's address: api.<domain> in production, '' (same-origin, proxied) in local dev. */
export const API_ORIGIN = process.env.AUTODEPLOY_API_ORIGIN ?? '';
export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;
/** An address the API gave out (e.g. a screenshot), as this browser should load it. */
export const apiAsset = (url: string) => apiUrl(url.replace(/^https?:\/\/[^/]+/, ''));
const credentials: RequestCredentials = API_ORIGIN ? 'include' : 'same-origin';
setCheckUrl(apiUrl('/readyz'));

const OUTAGE = 'AutoDeploy is down right now, so this couldn’t be done. Try again once it’s back.';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    const id = (problem as { requestId?: string }).requestId;
    const text = problem.detail ?? problem.title ?? `Request failed (${status})`;
    // Server errors name a request id; show it so it can be found in the logs.
    super(id ? `${text} (request id ${id})` : text);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
}

// A dangerous action can ask for a fresh authenticator code (403 mfa_required):
// the dashboard's prompt asks for one, then the request is sent once more.
let askForCode: (() => Promise<boolean>) | null = null;
export function setCodePrompt(fn: (() => Promise<boolean>) | null) {
  askForCode = fn;
}

export async function api<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string; retried?: boolean; moved?: boolean } = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('x-csrf-token', csrfToken);
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, method, headers, credentials });
  } catch {
    // No answer at all: the API (or this connection) is down.
    reportUnreachable();
    throw new ApiError(0, { title: 'Unreachable', detail: OUTAGE });
  }
  if (res.status === 204) {
    reportReachable();
    return undefined as T;
  }
  const text = await res.text();
  let body: (Partial<Problem> & { code?: string }) | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // The API always answers in JSON. Anything else came from the network in
    // front of it (Cloudflare or Caddy) because the API itself didn't answer.
    if (res.status >= 500) {
      reportUnreachable();
      throw new ApiError(0, { title: 'Unreachable', detail: OUTAGE });
    }
    throw new ApiError(res.status, {});
  }
  // A 5xx from the API itself (say, its database is down) leaves the verdict
  // to the readiness check, so the banner doesn't flicker.
  if (res.status < 500) reportReachable();
  if (!res.ok) {
    if (res.status === 401 && API_ORIGIN && !init.moved && (await moveSession()))
      return api<T>(path, { ...init, moved: true });
    if (res.status === 403 && body?.code === 'mfa_required' && askForCode && !init.retried) {
      if (await askForCode()) return api<T>(path, { ...init, retried: true });
    }
    throw new ApiError(res.status, body ?? {});
  }
  return body as T;
}

// People signed in before the dashboard called the API at its own address have
// their session in a cookie for this host. The first 401 trades it for a
// one-time pass here and hands that to the API, which keeps the same session
// under its own cookie: nobody signs in again. (Once per page load.)
// Remove with routes/session-move.ts after 2026-11-10.
let moving: Promise<boolean> | null = null;
function moveSession(): Promise<boolean> {
  moving ??= (async () => {
    try {
      const pass = await fetch('/auth/session/handoff', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!pass.ok) return false;
      const { code } = (await pass.json()) as { code: string };
      const claim = await fetch(apiUrl('/auth/session/claim'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return claim.ok;
    } catch {
      return false;
    }
  })();
  return moving;
}

export const post = <T>(path: string, body?: unknown, opts: { idempotencyKey?: string } = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), ...opts });
export const patch = <T>(path: string, body: unknown, headers?: HeadersInit) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...(headers && { headers }) });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', ...(body !== undefined && { body: JSON.stringify(body) }) });

export function newIdempotencyKey(prefix = 'ui') {
  return `${prefix}-${crypto.randomUUID()}`;
}

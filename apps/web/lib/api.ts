'use client';

import type { Problem } from '@autodeploy/contracts';

// Thin fetch wrapper: same-origin (cookies), CSRF header on writes, and
// RFC 9457 problem responses turned into typed errors the UI can show.

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
  init: RequestInit & { idempotencyKey?: string; retried?: boolean } = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('x-csrf-token', csrfToken);
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  const res = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 403 && body?.code === 'mfa_required' && askForCode && !init.retried) {
      if (await askForCode()) return api<T>(path, { ...init, retried: true });
    }
    throw new ApiError(res.status, body ?? {});
  }
  return body as T;
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

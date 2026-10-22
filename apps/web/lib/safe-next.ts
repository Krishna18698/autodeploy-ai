/**
 * Where to go after signing in: a path on this site only. "//evil.com" and
 * "/\\evil.com" start with "/" but browsers read them as another host.
 */
export function safeNext(next: string | null): string {
  if (!next || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f]/.test(next)) return '/overview';
  return next;
}

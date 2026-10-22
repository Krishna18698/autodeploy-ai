/**
 * Where to go after signing in: a path on this site only. "//evil.com" and
 * "/\\evil.com" start with "/" but browsers read them as another host.
 */
export function safeNext(next: string | null): string {
  if (!next || !/^\/(?![/\\])/.test(next)) return '/overview';
  // Control characters (tabs, newlines) are dropped by URL parsing, so "/\t/evil.com" is "//evil.com".
  for (const ch of next) if (ch.charCodeAt(0) < 0x20) return '/overview';
  return next;
}

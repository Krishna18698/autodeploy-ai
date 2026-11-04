import type { LogLine } from '@/components/ui/log-viewer';

/** Log order: attempt, then line number within it. */
const order = (a: LogLine, b: LogLine) => a.attemptNo - b.attemptNo || a.seq - b.seq;

/**
 * The log with `incoming` added: lines already seen (by attempt and line number)
 * are skipped. Lines arrive in order nearly always (history pages, then the live
 * stream), so they're appended; only an out-of-order batch (the stream before the
 * history, a reconnect) is merged with a sort, once.
 */
export function mergeLogLines(prev: LogLine[], incoming: LogLine[], seen: Set<string>): LogLine[] {
  const fresh: LogLine[] = [];
  for (const l of incoming) {
    const k = `${l.attemptNo}:${l.seq}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(l);
  }
  if (fresh.length === 0) return prev;
  if (fresh.some((l, i) => i > 0 && order(fresh[i - 1] as LogLine, l) > 0)) fresh.sort(order);
  const last = prev.at(-1);
  if (!last || order(last, fresh[0] as LogLine) < 0) return prev.concat(fresh);
  return [...prev, ...fresh].sort(order);
}

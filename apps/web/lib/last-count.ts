'use client';

import { useEffect, useState } from 'react';

/**
 * How many rows a list had the last time this browser showed it, so its
 * loading placeholders take the same space and nothing jumps when it fills.
 * A missing or blocked store just means the fallback.
 */
export function useLastCount(key: string, now: number | undefined, fallback: number, max: number) {
  const [last] = useState(() => {
    try {
      const v = Number.parseInt(localStorage.getItem(`ad:rows:${key}`) ?? '', 10);
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    if (now === undefined) return;
    try {
      localStorage.setItem(`ad:rows:${key}`, String(now));
    } catch {
      // Private mode or storage turned off: placeholders use the fallback.
    }
  }, [key, now]);
  return Math.max(1, Math.min(max, last));
}

// Run non-critical work (WebGL setup, scroll-scene wiring) after first paint,
// when the main thread is idle, so it never blocks hydration or input.
export function whenIdle(cb: () => void, timeout = 1500): () => void {
  if (typeof window === 'undefined') return () => {};
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(cb, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(cb, 200);
  return () => clearTimeout(t);
}

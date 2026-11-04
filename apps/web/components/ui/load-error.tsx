'use client';

import { ApiError } from '@/lib/api';
import { Button } from './button';

const why = (error: unknown) =>
  error instanceof ApiError && error.message ? error.message : 'Something went wrong.';

/** A list that couldn't load: never shown as an empty account or an endless placeholder. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="grid place-items-center gap-2 px-6 py-12 text-center">
      <p className="text-[14px] font-medium">Couldn’t load {what}</p>
      <p className="max-w-md text-[13px] text-muted">{why(error)}</p>
      <Button size="sm" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Rows already on screen stay when a refresh fails; this says they may be out of date. */
export function StaleNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-line bg-warn/5 px-4 py-2 text-[12px] text-muted"
    >
      <span className="min-w-0 flex-1">
        Couldn’t refresh: {why(error)} Showing what was loaded.
      </span>
      <button type="button" onClick={onRetry} className="font-medium text-fg hover:underline">
        Retry
      </button>
    </div>
  );
}

/** Below a paged list: how much is shown, and the next page. */
export function MorePages({
  shown,
  hasMore,
  loading,
  onMore,
}: {
  shown: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!shown) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 font-mono text-[11px] text-muted">
      <span>
        Showing {shown.toLocaleString()}
        {hasMore ? '' : ' (all)'}
      </span>
      {hasMore && (
        <Button size="sm" loading={loading} onClick={onMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

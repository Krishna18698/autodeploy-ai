'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { reportClientError } from '@/lib/report-error';

// A crash inside a dashboard page lands here instead of a blank screen, and is
// reported so it can be fixed without anyone sending a screenshot.
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => reportClientError('boundary', error, error.digest), [error]);
  return (
    <Panel>
      <div className="flex flex-col gap-3 py-6 text-center">
        <h1 className="text-[18px] font-semibold">This page hit an error</h1>
        <p className="text-[13px] text-muted">
          It has been reported automatically. Try again, or go back to the overview.
        </p>
        <div className="flex justify-center gap-2">
          <Button variant="primary" onClick={() => retry()}>
            Try again
          </Button>
          <Button onClick={() => location.assign('/overview')}>Overview</Button>
        </div>
        {error.digest && <p className="font-mono text-[11px] text-muted">ref {error.digest}</p>}
      </div>
    </Panel>
  );
}

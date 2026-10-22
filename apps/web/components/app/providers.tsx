'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { reportClientError } from '@/lib/report-error';
import { CodePrompt } from './code-prompt';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            // Don't hammer the API on auth/permission errors.
            retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
          },
        },
      }),
  );
  // Errors outside React's reach (event handlers, timers, stray promises).
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportClientError('error', e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) =>
      // API errors are already shown to the user as toasts; they are not crashes.
      e.reason instanceof ApiError ? undefined : reportClientError('unhandledrejection', e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return (
    <QueryClientProvider client={client}>
      <Toaster>
        {children}
        <CodePrompt />
      </Toaster>
    </QueryClientProvider>
  );
}

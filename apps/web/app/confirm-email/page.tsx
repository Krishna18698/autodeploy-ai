'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { ApiError, post } from '@/lib/api';

// The link that confirms an account's email lands here. It proves the address
// only, so it signs nobody in.
function ConfirmInner() {
  const token = useSearchParams().get('token') ?? '';
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete.');
  const [email, setEmail] = useState<string | null>(null);
  // A link works once: never send it twice (React runs effects twice in development).
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    post<{ email: string }>('/auth/email/confirm-address', { token })
      .then((r) => setEmail(r.email))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not reach AutoDeploy'),
      );
  }, [token]);

  const title = error
    ? 'Could not confirm your email'
    : email
      ? 'Email confirmed'
      : 'Confirming your email…';
  return (
    <AuthCard title={title}>
      {error ? (
        <>
          <Notice tone="fail">{error}</Notice>
          <p className="mt-4 text-[13px] text-muted">
            Send a fresh link from{' '}
            <Link href="/settings?tab=account" className="text-fg/80 hover:text-fg">
              Settings → Account
            </Link>
            .
          </p>
        </>
      ) : email ? (
        <>
          <Notice tone="ok">
            {email} is confirmed. You can also sign in with a Google account that uses it.
          </Notice>
          <p className="mt-4 text-[13px] text-muted">
            <Link href="/overview" className="text-fg/80 hover:text-fg">
              Go to AutoDeploy
            </Link>
          </p>
        </>
      ) : (
        <p className="mt-3 text-[14px] text-muted">One moment.</p>
      )}
    </AuthCard>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Providers>
      <Suspense>
        <ConfirmInner />
      </Suspense>
    </Providers>
  );
}

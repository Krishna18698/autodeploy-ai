'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { ApiError, post } from '@/lib/api';

// The link in the sign-up email lands here; confirming signs the person in.
function VerifyInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete.');
  // A link works once: never send it twice (React runs effects twice in development).
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    post('/auth/email/verify', { token })
      .then((r) =>
        router.replace((r as { twoFactor?: boolean }).twoFactor ? '/login/2fa' : '/overview'),
      )
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not reach AutoDeploy'),
      );
  }, [token, router]);

  return (
    <AuthCard title={error ? 'Could not confirm your email' : 'Confirming your email…'}>
      {error ? (
        <>
          <Notice tone="fail">{error}</Notice>
          <p className="mt-4 text-[13px] text-muted">
            <Link href="/login" className="text-fg/80 hover:text-fg">
              Sign in
            </Link>{' '}
            with your email and password and we will send a fresh link.
          </p>
        </>
      ) : (
        <p className="mt-3 text-[14px] text-muted">One moment.</p>
      )}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Providers>
      <Suspense>
        <VerifyInner />
      </Suspense>
    </Providers>
  );
}

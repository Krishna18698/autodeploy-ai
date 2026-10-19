'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';

// Local development and the local e2e build only; never shown in production.
const DEV_LOGIN =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const next = params.get('next') ?? '/overview';

  const devLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      await post('/auth/dev-login', {});
      router.replace(next.startsWith('/') ? next : '/overview');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API');
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-svh place-items-center px-4">
      <div className="w-full max-w-sm rounded-[10px] border border-line bg-panel p-6">
        <div className="mb-6 flex items-center gap-2 text-sm font-semibold">
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-[6px] bg-run text-[12px] text-bg"
          >
            ◆
          </span>
          AutoDeploy
        </div>
        <h1 className="text-[20px] font-semibold tracking-tight">
          Sign in to deploy <span className="font-serif font-normal italic">your repos.</span>
        </h1>
        <div className="mt-6 flex flex-col gap-2">
          <a
            href="/auth/github/login"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-fg text-[13px] font-medium text-bg hover:bg-fg/90"
          >
            Continue with GitHub
          </a>
          {DEV_LOGIN && (
            <Button variant="secondary" loading={loading} onClick={devLogin} className="h-10">
              Developer sign-in (local only)
            </Button>
          )}
        </div>
        <p className="mt-4 text-[12px] leading-5 text-muted">
          By continuing you agree to the{' '}
          <Link href="/terms" className="text-fg/80 underline-offset-2 hover:underline">
            Terms
          </Link>
          ,{' '}
          <Link href="/acceptable-use" className="text-fg/80 underline-offset-2 hover:underline">
            Acceptable Use
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="text-fg/80 underline-offset-2 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-[12px] text-fail"
          >
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Providers>
      <Suspense>
        <LoginInner />
      </Suspense>
    </Providers>
  );
}

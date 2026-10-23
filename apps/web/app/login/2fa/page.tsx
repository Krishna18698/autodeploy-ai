'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, Field, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';
import { safeNext } from '@/lib/safe-next';

// The second step of signing in, for accounts with an authenticator app.
function TwoFactorInner() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Remembered: later sign-ins on this browser skip the code (30 days, or 14
  // unused), unless one comes from another country or after wrong passwords.
  const [remember, setRemember] = useState(true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post('/auth/2fa/verify', { code, remember });
      router.replace(next);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'This sign-in expired. Sign in again.'
          : err instanceof ApiError
            ? err.message
            : 'Could not reach AutoDeploy',
      );
      setLoading(false);
    }
  };
  const startOver = async () => {
    await post('/auth/logout').catch(() => {});
    router.replace('/login');
  };

  return (
    <AuthCard title="Enter your code">
      <p className="mt-2 text-[14px] leading-6 text-muted">
        {recovery
          ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once.'
          : 'Open your authenticator app and enter the 6-digit code for AutoDeploy.'}
      </p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <Field
          key={recovery ? 'recovery' : 'app'}
          label={recovery ? 'Recovery code' : 'Code'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={recovery ? 'text' : 'numeric'}
          placeholder={recovery ? 'abcd-efgh' : '123456'}
          maxLength={recovery ? 20 : 7}
          required
        />
        <label className="flex items-start gap-2.5 text-[13px] leading-5 text-fg/85">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-run)]"
          />
          <span>
            Trust this browser for 30 days
            <span className="block text-[12px] text-muted">
              Untick on a shared computer. Important changes still ask for a code.
            </span>
          </span>
        </label>
        {error && <Notice tone="fail">{error}</Notice>}
        <Button type="submit" variant="primary" loading={loading} className="h-10">
          Continue
        </Button>
      </form>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-[13px]">
        <button
          type="button"
          onClick={() => {
            setRecovery((r) => !r);
            setCode('');
            setError(null);
          }}
          className="text-fg/80 hover:text-fg"
        >
          {recovery ? 'Use the app instead' : 'Use a recovery code'}
        </button>
        <button type="button" onClick={startOver} className="text-muted hover:text-fg">
          Sign in as someone else
        </button>
      </div>
    </AuthCard>
  );
}

export default function TwoFactorPage() {
  return (
    <Providers>
      <Suspense>
        <TwoFactorInner />
      </Suspense>
    </Providers>
  );
}

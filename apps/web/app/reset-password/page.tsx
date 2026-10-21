'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, Field, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';

// The link in the "reset your password" email lands here.
function ResetInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords are different.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await post('/auth/email/reset', { token, password });
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach AutoDeploy');
      setLoading(false);
    }
  };

  if (!token)
    return (
      <AuthCard title="Reset your password">
        <Notice tone="fail">This link is incomplete.</Notice>
        <p className="mt-4 text-[13px]">
          <Link href="/forgot-password" className="text-fg/80 hover:text-fg">
            Ask for a new link
          </Link>
        </p>
      </AuthCard>
    );

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint="At least 10 characters. Every other device gets signed out."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="Repeat it"
          type="password"
          autoComplete="new-password"
          required
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={loading} className="h-10">
          Save and sign in
        </Button>
      </form>
      {error && (
        <>
          <Notice tone="fail">{error}</Notice>
          <p className="mt-3 text-[13px]">
            <Link href="/forgot-password" className="text-fg/80 hover:text-fg">
              Ask for a new link
            </Link>
          </p>
        </>
      )}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Providers>
      <Suspense>
        <ResetInner />
      </Suspense>
    </Providers>
  );
}

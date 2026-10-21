'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthCard, Field, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';

// Local development and the local e2e build only; never shown in production.
const DEV_LOGIN =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'signin' | 'signup'>(
    params.get('mode') === 'signup' ? 'signup' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState<'email' | 'dev' | null>(null);
  const next = params.get('next') ?? '/overview';
  const goNext = () => router.replace(next.startsWith('/') ? next : '/overview');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading('email');
    setError(null);
    try {
      if (mode === 'signup') {
        await post('/auth/email/signup', { email, password });
        setSentTo(email);
      } else {
        await post('/auth/email/login', { email, password });
        goNext();
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach AutoDeploy');
    }
    setLoading(null);
  };

  const devLogin = async () => {
    setLoading('dev');
    setError(null);
    try {
      await post('/auth/dev-login', {});
      goNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API');
      setLoading(null);
    }
  };

  if (sentTo)
    return (
      <AuthCard title="Check your email">
        <p className="mt-3 text-[14px] leading-6 text-fg/90">
          We sent a link to <strong className="font-medium text-fg">{sentTo}</strong>. Open it to
          finish creating your account; it works for 24 hours.
        </p>
        <p className="mt-3 text-[13px] text-muted">
          Nothing there? Check spam, or{' '}
          <button
            type="button"
            className="text-fg/80 underline-offset-2 hover:underline"
            onClick={() => {
              setSentTo(null);
              setMode('signup');
            }}
          >
            try again
          </button>{' '}
          in a minute.
        </p>
      </AuthCard>
    );

  const signup = mode === 'signup';
  return (
    <AuthCard
      title={
        signup ? (
          <>
            Create your <span className="font-serif font-normal italic">account.</span>
          </>
        ) : (
          <>
            Sign in to deploy <span className="font-serif font-normal italic">your repos.</span>
          </>
        )
      }
    >
      <div className="mt-6 flex flex-col gap-2">
        <a
          href="/auth/github/login"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-fg text-[13px] font-medium text-bg hover:bg-fg/90"
        >
          Continue with GitHub
        </a>
        {DEV_LOGIN && (
          <Button
            variant="secondary"
            loading={loading === 'dev'}
            onClick={devLogin}
            className="h-10"
          >
            Developer sign-in (local only)
          </Button>
        )}
      </div>

      <div className="my-5 flex items-center gap-3 text-[12px] text-muted">
        <span className="h-px flex-1 bg-line" />
        or with email
        <span className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete={signup ? 'new-password' : 'current-password'}
          required
          minLength={signup ? 10 : undefined}
          hint={signup ? 'At least 10 characters.' : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={loading === 'email'} className="h-10">
          {signup ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      {error && <Notice tone="fail">{error}</Notice>}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px]">
        {signup ? (
          <span />
        ) : (
          <Link href="/forgot-password" className="text-muted hover:text-fg">
            Forgot password?
          </Link>
        )}
        <button
          type="button"
          className="text-fg/80 hover:text-fg"
          onClick={() => {
            setMode(signup ? 'signin' : 'signup');
            setError(null);
          }}
        >
          {signup ? 'Have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>

      <p className="mt-5 text-[12px] leading-5 text-muted">
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
    </AuthCard>
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

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthCard, Field, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, api, apiUrl, post } from '@/lib/api';
import { useProviders } from '@/lib/queries';
import { safeNext } from '@/lib/safe-next';

// Local development and the local e2e build only; never shown in production.
const DEV_LOGIN =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_DEV_LOGIN === '1';

const SIGN_IN_ERRORS: Record<string, string> = {
  expired: 'That sign-in link expired or was already used. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  github: 'GitHub didn’t answer as expected. Please try again in a moment.',
  google: 'Google didn’t answer as expected. Please try again in a moment.',
  closed: 'Sign-ups are not open yet.',
  relogin: 'Sign in again, then connect it from Settings.',
  google_unverified:
    'Google hasn’t verified that email address, so it can’t be used to sign in here.',
  google_unconfirmed:
    'An account with this email is waiting to be confirmed: open the link we emailed you (or sign in with its password), then connect Google in Settings.',
  google_other: 'That account is already linked to a different Google account.',
  google_ambiguous:
    'More than one AutoDeploy account uses this email. Sign in the way you usually do, then connect Google in Settings → Account.',
  github_email_taken:
    'An AutoDeploy account already uses the email on this GitHub account. Sign in to it with email or Google, then connect GitHub in Settings → Account.',
};

function LoginInner() {
  const router = useRouter();
  // The query string, read after the first paint: with useSearchParams the whole card
  // would only appear once the page's JavaScript ran (4 s on a slow phone).
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setParams(q);
    if (q.get('mode') === 'signup') setMode('signup');
    // Set by the GitHub sign-in when it sends someone back: fixed messages only.
    setError(SIGN_IN_ERRORS[q.get('error') ?? ''] ?? null);
  }, []);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState<'email' | 'dev' | null>(null);
  const next = safeNext(params?.get('next') ?? null);
  // Shown at once (no jump when the answer comes); hidden only where the
  // server says Google isn't set up (local development).
  const google = useProviders().data?.google !== false;
  const goNext = () => router.replace(next);
  // An account with an authenticator signs in, then shows a code.
  const afterSignIn = (r: { twoFactor?: boolean }) =>
    r.twoFactor ? router.replace(`/login/2fa?next=${encodeURIComponent(next)}`) : goNext();
  // Already signed in (on this browser, or through the dashboard's old
  // address, which this moves over): straight in, no form.
  useEffect(() => {
    if (!params) return;
    api('/api/v1/me')
      .then(() => router.replace(next))
      .catch(() => {});
  }, [router, next, params]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading('email');
    setError(null);
    try {
      if (mode === 'signup') {
        await post('/auth/email/signup', { email, password });
        setSentTo(email);
      } else {
        const r = await post<{ twoFactor?: boolean }>('/auth/email/login', { email, password });
        afterSignIn(r);
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
      afterSignIn(await post<{ twoFactor?: boolean }>('/auth/dev-login', {}));
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
    <AuthCard title={signup ? 'Create your account' : 'Sign in to AutoDeploy'}>
      <div className="mt-6 flex flex-col gap-2">
        <a
          href={apiUrl('/auth/github/login')}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-fg text-[13px] font-medium text-bg hover:bg-fg/90 group-disabled/paused:pointer-events-none group-disabled/paused:opacity-50"
        >
          Continue with GitHub
        </a>
        {google && (
          <a
            href={apiUrl('/auth/google/login')}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-bg text-[13px] font-medium text-fg hover:bg-raised group-disabled/paused:pointer-events-none group-disabled/paused:opacity-50"
          >
            <GoogleMark />
            Continue with Google
          </a>
        )}
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
      <LoginInner />
    </Providers>
  );
}

/** Google's "G", as its sign-in branding asks. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-4">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthCard, Field, Notice } from '@/components/app/auth-card';
import { Providers } from '@/components/app/providers';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';

function ForgotInner() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post('/auth/email/forgot', { email });
      setSentTo(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach AutoDeploy');
    }
    setLoading(false);
  };

  return (
    <AuthCard title="Reset your password">
      {sentTo ? (
        <p className="mt-3 text-[14px] leading-6 text-fg/90">
          If <strong className="font-medium text-fg">{sentTo}</strong> has an AutoDeploy account, we
          have emailed it a link to choose a new password. The link works for 1 hour.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={loading} className="h-10">
            Email me a link
          </Button>
        </form>
      )}
      {error && <Notice tone="fail">{error}</Notice>}
      <p className="mt-5 text-[13px] text-muted">
        Signed in with GitHub? There is no password to reset;{' '}
        <Link href="/login" className="text-fg/80 hover:text-fg">
          continue with GitHub
        </Link>
        .
      </p>
    </AuthCard>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Providers>
      <ForgotInner />
    </Providers>
  );
}

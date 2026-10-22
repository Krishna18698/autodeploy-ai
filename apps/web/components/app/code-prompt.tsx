'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, post, setCodePrompt } from '@/lib/api';

// Shown when a dangerous action needs a fresh authenticator code. The action
// is sent again by lib/api once the code is accepted; Cancel abandons it.
export function CodePrompt() {
  const ref = useRef<HTMLDialogElement>(null);
  const resolve = useRef<((ok: boolean) => void) | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCodePrompt(
      () =>
        new Promise<boolean>((done) => {
          resolve.current = done;
          setCode('');
          setError(null);
          ref.current?.showModal();
        }),
    );
    return () => setCodePrompt(null);
  }, []);

  const finish = (ok: boolean) => {
    resolve.current?.(ok);
    resolve.current = null;
    if (ref.current?.open) ref.current.close();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/v1/me/2fa/verify', { code });
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={() => finish(false)}
      aria-labelledby="code-prompt-title"
      className="m-auto w-[min(92vw,400px)] rounded-[10px] border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <form onSubmit={submit} className="p-5">
        <h2 id="code-prompt-title" className="text-[15px] font-semibold">
          Confirm it’s you
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Enter the code from your authenticator app (or a recovery code) to continue.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Code"
          autoComplete="one-time-code"
          inputMode="text"
          placeholder="123 456"
          autoFocus
          className="mt-4 h-10 w-full rounded-md border border-line bg-bg px-3 font-mono text-[16px] tracking-widest text-fg outline-none focus:border-run/60"
        />
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-fail">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>
            Continue
          </Button>
        </div>
      </form>
    </dialog>
  );
}

import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { OutageBanner, PausedWhenDown } from './outage-banner';

// The card every sign-in screen sits in: sign in, confirm email, forgot and
// reset password.
export function AuthCard({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-svh place-items-center px-4 py-10">
      <div className="glass relative w-full max-w-sm rounded-2xl bg-panel/80 p-7 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
        <Link href="/" className="mb-7 inline-flex" aria-label="AutoDeploy home">
          <Logo size={30} />
        </Link>
        {/* A way out for anyone who changes their mind (the logo alone doesn't say it). */}
        <Link
          href="/"
          aria-label="Close and go back to the home page"
          title="Back to home"
          className="absolute right-3 top-3 grid size-10 place-items-center rounded-lg text-muted transition-colors hover:bg-white/6 hover:text-fg"
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </Link>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-4 empty:hidden">
          <OutageBanner where="signin" />
        </div>
        <PausedWhenDown>{children}</PausedWhenDown>
      </div>
    </main>
  );
}

// 16px text on phones, so iOS doesn't zoom into the field.
export const fieldClass =
  'h-10 w-full rounded-md border border-line bg-bg px-3 text-[16px] text-fg outline-none placeholder:text-muted/60 focus:border-run/60 sm:text-[14px]';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.ComponentProps<'input'>) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <input {...input} className={fieldClass} />
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export function Notice({ tone, children }: { tone: 'ok' | 'fail'; children: React.ReactNode }) {
  const cls =
    tone === 'ok' ? 'border-ok/40 bg-ok/10 text-fg/90' : 'border-fail/40 bg-fail/10 text-fail';
  return (
    <p
      role={tone === 'fail' ? 'alert' : 'status'}
      className={`mt-4 rounded-md border px-3 py-2 text-[13px] leading-5 ${cls}`}
    >
      {children}
    </p>
  );
}

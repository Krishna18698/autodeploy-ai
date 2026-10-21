import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
const V: Record<Variant, string> = {
  primary: 'bg-run text-bg hover:bg-run/90',
  secondary: 'border border-line bg-raised text-fg hover:border-muted/60',
  ghost: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'border border-fail/40 bg-fail/10 text-fail hover:bg-fail/20',
  ai: 'border border-ai/40 bg-ai/10 text-ai hover:bg-ai/20',
};
const base =
  'inline-flex items-center justify-center gap-2 rounded-md text-[13px] font-medium transition-[background,border,color,transform] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  children,
  className = '',
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`${base} ${V[variant]} ${size === 'sm' ? 'h-7 px-2.5 pointer-coarse:h-9' : 'h-9 px-3.5 pointer-coarse:h-10'} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="size-3 animate-spin rounded-full border border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = 'secondary',
  href,
  children,
  className = '',
}: {
  variant?: Variant;
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={`${base} ${V[variant]} h-9 px-3.5 ${className}`}>
      {children}
    </Link>
  );
}

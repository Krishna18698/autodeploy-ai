import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { OrbitRing, WaveDots } from './loaders';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
const V: Record<Variant, string> = {
  primary: 'bg-fg text-bg shadow-[0_1px_0_rgb(255_255_255/0.25)_inset] hover:bg-fg/90',
  secondary: 'border border-white/8 bg-white/4 text-fg hover:bg-white/7',
  ghost: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'border border-fail/40 bg-fail/10 text-fail hover:bg-fail/20',
  ai: 'border border-ai/40 bg-ai/10 text-ai hover:bg-ai/20',
};
const base =
  'inline-flex items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-[background,border,color,transform] active:scale-[0.98] disabled:pointer-events-none';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loader = 'ring',
  children,
  className = '',
  ...rest
}: ComponentProps<'button'> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  /** While loading: the orbit ring, or wave dots for approving and deploying. */
  loader?: 'ring' | 'dots';
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      // A disabled button fades; a busy one stays clear so its animation reads.
      className={`${base} ${loading ? '' : 'disabled:opacity-50'} ${V[variant]} ${size === 'sm' ? 'h-7 px-2.5 pointer-coarse:h-9' : 'h-9 px-3.5 pointer-coarse:h-10'} ${className}`}
    >
      {loading &&
        (loader === 'dots' ? <WaveDots onLight={variant === 'primary'} /> : <OrbitRing />)}
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

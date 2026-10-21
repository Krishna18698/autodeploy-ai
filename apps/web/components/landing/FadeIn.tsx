'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

// Content rises in gently the first time it scrolls into view. Visible from
// the start for reduced motion and if the observer never runs, so nothing is
// ever stuck hidden.
export function FadeIn({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'shown' | 'waiting' | 'in'>('shown');

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Already on screen at load: leave it as it is.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) return;
    setState('waiting');
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setState('in');
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: state === 'in' ? `${delay}ms` : undefined }}
      className={`transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        state === 'waiting' ? 'translate-y-4 opacity-0' : 'translate-y-0 opacity-100'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** The heading block every landing section opens with. */
export function SectionHead({
  eyebrow,
  title,
  sub,
  center = false,
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  center?: boolean;
}) {
  return (
    <FadeIn className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <p className="text-[13px] font-medium text-run">{eyebrow}</p>
      <h2 className="mt-3 text-[clamp(1.9rem,3.6vw,2.9rem)] font-semibold leading-[1.08] tracking-[-0.025em] text-fg">
        {title}
      </h2>
      {sub && <p className="mt-4 text-[16px] leading-relaxed text-muted">{sub}</p>}
    </FadeIn>
  );
}

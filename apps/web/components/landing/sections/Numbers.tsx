'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef } from 'react';
import { MEASURED } from '@/lib/measured';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function Numbers() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      for (const el of gsap.utils.toArray<HTMLElement>('[data-count]')) {
        const target = Number(el.dataset.count);
        const decimals = Number(el.dataset.decimals ?? 0);
        if (reduced) continue;
        const o = { v: 0 };
        gsap.to(o, {
          v: target,
          duration: 1.6,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 85%' },
          onUpdate: () => {
            el.textContent = o.v.toFixed(decimals);
          },
        });
      }
      if (!reduced)
        gsap.from('[data-stat]', {
          y: 24,
          opacity: 0,
          stagger: 0.12,
          duration: 0.8,
          ease: 'expo.out',
          scrollTrigger: { trigger: root.current, start: 'top 75%' },
        });
    },
    { scope: root },
  );
  return (
    <section ref={root} id="numbers" className="mx-auto max-w-7xl px-4 py-28 sm:px-6">
      <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-run">04 · proof</p>
      <h2 className="mt-3 max-w-2xl text-[clamp(2rem,4.4vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
        Numbers we <span className="font-serif font-normal italic">measured.</span>
      </h2>
      <p className="mt-4 max-w-xl text-[15px] text-muted">
        Not projections. Each figure comes from a test or a run you can reproduce from the
        repository.
      </p>
      <dl className="mt-12 grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {MEASURED.map((m) => (
          <div key={m.label} data-stat className="bg-bg p-6">
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
              {m.label}
            </dt>
            <dd className="mt-3 text-[clamp(2.4rem,4vw,3.4rem)] font-semibold tracking-tight">
              <span data-count={m.value} data-decimals={m.decimals}>
                {m.value.toFixed(m.decimals)}
              </span>
              <span className="ml-1 text-[0.45em] font-normal text-muted">{m.unit}</span>
            </dd>
            <dd className="mt-2 text-[13px] text-muted">{m.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef } from 'react';
import { whenIdle } from '@/lib/idle';

gsap.registerPlugin(useGSAP, ScrollTrigger);

// The one full-screen colour moment: a cyan panel sweeps across with the
// mark, then clears to reveal the measured numbers.
export function Wipe() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    (_ctx, contextSafe) => {
      // Below the fold: set up after first paint.
      return whenIdle(
        contextSafe?.(() => {
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          gsap
            .timeline({
              scrollTrigger: {
                trigger: root.current,
                start: 'top 85%',
                end: 'bottom 15%',
                scrub: 0.5,
              },
            })
            .fromTo(
              '[data-panel]',
              { clipPath: 'inset(0 100% 0 0)' },
              { clipPath: 'inset(0 0% 0 0)', ease: 'none', duration: 1 },
            )
            .fromTo(
              '[data-mark]',
              { scale: 0.6, rotate: -45, opacity: 0 },
              { scale: 1, rotate: 0, opacity: 1, ease: 'back.out(2)', duration: 0.5 },
              0.4,
            )
            .to(
              '[data-panel]',
              { clipPath: 'inset(0 0% 0 100%)', ease: 'none', duration: 1 },
              '+=0.3',
            );
        }) ?? (() => {}),
      );
    },
    { scope: root },
  );
  return (
    <section ref={root} aria-hidden className="relative h-[70vh]">
      <div
        data-panel
        className="sticky top-0 grid h-[70vh] place-items-center bg-run [clip-path:inset(0_100%_0_0)] motion-reduce:hidden"
      >
        <div
          data-mark
          className="grid size-20 place-items-center rounded-2xl bg-bg text-3xl text-run"
        >
          ◆
        </div>
      </div>
    </section>
  );
}

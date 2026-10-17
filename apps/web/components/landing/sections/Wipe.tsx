'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

// The one full-screen colour moment: a cyan panel sweeps across with the
// mark, then clears to reveal the measured numbers. On phones a full screen of
// flat cyan read as an empty block, so there it is a band with the wordmark.
export function Wipe() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
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
        .to('[data-panel]', { clipPath: 'inset(0 0% 0 100%)', ease: 'none', duration: 1 }, '+=0.3');
    },
    { scope: root },
  );
  return (
    <section ref={root} aria-hidden className="relative h-[28svh] md:h-[70vh]">
      <div
        data-panel
        className="sticky top-0 flex h-[28svh] items-center justify-center gap-4 bg-run [clip-path:inset(0_100%_0_0)] motion-reduce:hidden md:h-[70vh]"
      >
        <div
          data-mark
          className="grid size-14 place-items-center rounded-2xl bg-bg text-2xl text-run md:size-20 md:text-3xl"
        >
          ◆
        </div>
        <span className="text-[28px] font-semibold tracking-tight text-bg md:hidden">
          AutoDeploy
        </span>
      </div>
    </section>
  );
}

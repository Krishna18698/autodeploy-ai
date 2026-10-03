'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { RefObject } from 'react';
import { whenIdle } from '@/lib/idle';

gsap.registerPlugin(useGSAP, ScrollTrigger);

/**
 * A pinned, scroll-scrubbed scene on desktop; a simple reveal on small
 * screens; nothing at all with reduced motion (the static end state shows).
 */
export function useScrollScene(
  scope: RefObject<HTMLElement | null>,
  build: (tl: gsap.core.Timeline, mobile: boolean) => void,
  pinLength = '+=140%',
) {
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      // Wire the scene after first paint: pinning measures layout, which is
      // expensive and pointless before the user can even scroll.
      let mm: gsap.MatchMedia | undefined;
      const cancel = whenIdle(() => {
        mm = gsap.matchMedia();
        mm.add('(min-width: 768px)', () => {
          const tl = gsap.timeline({
            defaults: { ease: 'none' },
            scrollTrigger: {
              trigger: scope.current,
              start: 'top top',
              end: pinLength,
              pin: true,
              scrub: 0.6,
            },
          });
          build(tl, false);
        });
        mm.add('(max-width: 767px)', () => {
          const tl = gsap.timeline({
            defaults: { ease: 'power2.out', duration: 0.6 },
            scrollTrigger: {
              trigger: scope.current,
              start: 'top 70%',
              toggleActions: 'play none none reverse',
            },
          });
          build(tl, true);
        });
      });
      return () => {
        cancel();
        mm?.revert();
      };
    },
    { scope },
  );
}

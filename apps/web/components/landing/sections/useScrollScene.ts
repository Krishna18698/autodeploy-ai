'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import type { RefObject } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);
// Phones fire resize whenever the address bar slides in or out; re-measuring
// then (scroll to 0, restore) jolts the page. Real rotations still refresh.
ScrollTrigger.config({ ignoreMobileResize: true });

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
      // Wire the scene at mount, before Lenis starts. Creating a pin saves and
      // restores the scroll position from ScrollTrigger's cache, which trails
      // Lenis by a frame; done mid-scroll (as an idle callback after a slow
      // load), that pulled the page back ~15 px.
      const mm = gsap.matchMedia();
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
      return () => mm.revert();
    },
    { scope },
  );
}

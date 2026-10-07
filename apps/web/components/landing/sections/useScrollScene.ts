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
 * A short scene that plays once when its section scrolls into view, on every
 * screen size. No pinning or scroll-scrubbing: the page never holds the
 * reader back, the content is there within ~1.5 s of arriving. Nothing at all
 * with reduced motion (the static end state shows).
 */
export function useScrollScene(
  scope: RefObject<HTMLElement | null>,
  build: (tl: gsap.core.Timeline) => void,
) {
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const tl = gsap.timeline({
        defaults: { ease: 'power2.out', duration: 0.6 },
        scrollTrigger: { trigger: scope.current, start: 'top 70%', once: true },
      });
      build(tl);
      // Cap the whole scene so a long storyboard never makes anyone wait.
      if (tl.duration() > MAX_SCENE_SECONDS) tl.timeScale(tl.duration() / MAX_SCENE_SECONDS);
    },
    { scope },
  );
}

const MAX_SCENE_SECONDS = 1.6;

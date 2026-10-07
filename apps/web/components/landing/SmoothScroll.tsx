'use client';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { useEffect } from 'react';

// Lenis drives scrolling; GSAP's ticker drives Lenis so ScrollTrigger and the
// smooth scroll share one clock.
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.registerPlugin(ScrollTrigger);
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    // Keep Lenis's scroll limit in step if the page height changes. (With no
    // pinned sections, a refresh no longer moves the page, so nothing else.)
    const onRefresh = () => lenis.resize();
    ScrollTrigger.addEventListener('refresh', onRefresh);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      ScrollTrigger.removeEventListener('refresh', onRefresh);
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);
  return null;
}

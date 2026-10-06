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
    // A ScrollTrigger refresh (e.g. on resize) scrolls to 0 to measure, then
    // restores a cached position that trails Lenis by a frame or two; mid-glide
    // that visibly pulled the page back. Put Lenis back where it really was,
    // then let it finish the glide.
    let before: { at: number; to: number } | null = null;
    const onRefreshInit = () => {
      before = lenis.isScrolling ? { at: lenis.animatedScroll, to: lenis.targetScroll } : null;
    };
    const onRefresh = () => {
      lenis.resize();
      if (before) {
        lenis.scrollTo(before.at, { immediate: true, force: true });
        lenis.scrollTo(before.to, { force: true });
      }
      before = null;
    };
    ScrollTrigger.addEventListener('refreshInit', onRefreshInit);
    ScrollTrigger.addEventListener('refresh', onRefresh);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      ScrollTrigger.removeEventListener('refreshInit', onRefreshInit);
      ScrollTrigger.removeEventListener('refresh', onRefresh);
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);
  return null;
}

'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import { useRef } from 'react';
import { DemoVideo } from './DemoVideo';
import { HeroCard } from './HeroCard';

gsap.registerPlugin(useGSAP, SplitText);

export function Hero() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const split = SplitText.create('[data-split]', {
        type: 'lines,words',
        mask: 'lines',
        aria: 'none',
      });
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from(split.words, { yPercent: 110, duration: 1.1, stagger: 0.06 })
        .from('[data-accent]', { yPercent: 110, opacity: 0, duration: 1.2 }, '-=0.7')
        .from('[data-fade]', { y: 14, opacity: 0, duration: 0.9, stagger: 0.08 }, '-=0.9')
        .from('[data-card]', { y: 40, opacity: 0, duration: 1.4 }, 0.25);
      return () => split.revert();
    },
    { scope: root },
  );

  return (
    <section
      ref={root}
      className="relative mx-auto grid min-h-svh max-w-7xl items-center gap-12 px-4 pb-16 pt-28 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-20"
    >
      <div>
        <p
          data-fade
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-line bg-panel/60 px-2.5 py-1 font-mono text-[11px] text-muted"
        >
          <span className="size-1.5 rounded-full bg-run" />
          open beta · static sites · ₹0 to run
        </p>
        <h1 className="text-[clamp(2.6rem,6.4vw,5.25rem)] font-semibold leading-[0.98] tracking-[-0.035em]">
          <span data-split className="block">
            Deploys that fix
          </span>
          <span className="block overflow-hidden pb-[0.08em]">
            <span
              data-accent
              className="inline-block font-serif font-normal italic tracking-[-0.01em] text-fg/95"
            >
              themselves.
            </span>
          </span>
        </h1>
        <p data-fade className="mt-6 max-w-md text-[15px] leading-relaxed text-muted">
          Connect a repo. AutoDeploy detects how to build it, runs it in a sandbox, repairs the
          failures it understands, validates the result — and shows you every decision it made.
        </p>
        <div data-fade className="mt-8 flex flex-wrap items-center gap-3">
          <a
            id="start"
            href="/login"
            className="rounded-full bg-run px-5 py-2.5 text-sm font-medium text-bg transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            Connect GitHub
          </a>
          <DemoVideo />
        </div>
        <p data-fade className="mt-5 font-mono text-[11px] text-muted">
          free · no card · rules first, AI only when needed
        </p>
      </div>
      <div data-card className="lg:justify-self-end">
        <HeroCard />
      </div>
    </section>
  );
}

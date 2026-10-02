'use client';

import { useRef } from 'react';
import { useScrollScene } from './useScrollScene';

const DEPLOYS = [
  { n: 124, h: 70 },
  { n: 125, h: 95 },
  { n: 126, h: 60 },
  { n: 127, h: 110 },
  { n: 128, h: 85 },
];

export function Record() {
  const root = useRef<HTMLElement>(null);
  useScrollScene(root, (tl, mobile) => {
    tl.from('[data-block]', {
      scaleY: 0,
      transformOrigin: 'bottom',
      stagger: 0.15,
      duration: 0.5,
      ease: mobile ? 'power2.out' : 'none',
    })
      .to(
        '[data-block="4"] [data-top]',
        {
          backgroundColor: 'rgba(34,211,238,0.85)',
          boxShadow: '0 0 40px rgba(34,211,238,0.45)',
          duration: 0.3,
        },
        '+=0.2',
      )
      .to(
        '[data-block="4"] [data-top]',
        {
          backgroundColor: 'rgba(138,147,163,0.35)',
          boxShadow: '0 0 0 rgba(0,0,0,0)',
          duration: 0.3,
        },
        '+=0.5',
      )
      .to(
        '[data-block="3"] [data-top]',
        {
          backgroundColor: 'rgba(34,211,238,0.85)',
          boxShadow: '0 0 40px rgba(34,211,238,0.45)',
          duration: 0.3,
        },
        '<',
      )
      .from('[data-rollback-note]', { opacity: 0, y: 6, duration: 0.3 });
  });
  return (
    <section ref={root} className="relative flex min-h-dvh items-center">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-run">03 · release</p>
          <h2 className="mt-3 text-[clamp(2rem,4.4vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
            Every deploy is <span className="font-serif font-normal italic">on the record.</span>
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Builds are content-addressed and immutable. Going live — or going back — moves one
            pointer at the edge. No rebuild, no downtime, no guessing which files are served.
          </p>
        </div>
        <div className="relative h-[340px] [perspective:1200px]">
          <div className="absolute inset-x-6 bottom-10 top-10 [transform:rotateX(55deg)_rotateZ(-35deg)] [transform-style:preserve-3d]">
            <div className="absolute inset-0 rounded-xl border border-line bg-panel/40" />
            {DEPLOYS.map((d, i) => (
              <div
                key={d.n}
                data-block={i}
                className="absolute bottom-[12%] w-[13%] [transform-style:preserve-3d]"
                style={{ left: `${8 + i * 18}%`, height: `${d.h}%` }}
              >
                <div
                  data-top
                  className="absolute inset-0 rounded-md border border-line/80 bg-muted/35 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
                />
                <div className="absolute -bottom-6 left-0 font-mono text-[10px] text-muted [transform:rotateZ(35deg)_rotateX(-55deg)]">
                  #{d.n}
                </div>
              </div>
            ))}
          </div>
          <p
            data-rollback-note
            className="absolute bottom-0 left-0 right-0 text-center font-mono text-[12px] text-muted"
          >
            rollback #128 → #127 · <span className="text-ok">11.7 ms</span> · nothing rebuilt
          </p>
        </div>
      </div>
    </section>
  );
}

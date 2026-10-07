'use client';

import type React from 'react';
import { useRef } from 'react';
import { useScrollScene } from './useScrollScene';

// h = block height in px (build size); blocks rise out of the floor plane.
const DEPLOYS = [
  { n: 124, h: 56 },
  { n: 125, h: 84 },
  { n: 126, h: 44 },
  { n: 127, h: 104 },
  { n: 128, h: 72 },
];
const TOP = '#2b313b';
const LIVE = { backgroundColor: '#22d3ee', boxShadow: '0 0 40px rgba(34,211,238,0.45)' };
const IDLE = { backgroundColor: TOP, boxShadow: '0 0 0 rgba(0,0,0,0)' };
// The static end state (and the reduced-motion view): #127 live after the rollback.
const LIVE_INDEX = 3;
// Walls of a box standing on the floor, in the floor's own coordinates
// (x right, y down, z up out of the floor). Each wall hinges on a base edge.
const WALLS = [
  { cls: 'left-0 top-0 h-[var(--h)] w-full origin-top [transform:rotateX(90deg)]', bg: '#161a20' },
  {
    cls: 'left-0 top-full h-[var(--h)] w-full origin-top [transform:rotateX(90deg)]',
    bg: '#1d222a',
  },
  {
    cls: 'left-0 top-0 h-full w-[var(--h)] origin-left [transform:rotateY(-90deg)]',
    bg: '#232933',
  },
  {
    cls: 'left-full top-0 h-full w-[var(--h)] origin-left [transform:rotateY(-90deg)]',
    bg: '#14181d',
  },
];

export function Record() {
  const root = useRef<HTMLElement>(null);
  useScrollScene(root, (tl) => {
    // GSAP can't read a CSS variable's resting value, so give it explicitly.
    tl.fromTo(
      '[data-block]',
      { '--h': '0px' },
      {
        '--h': (i: number) => `${DEPLOYS[i]?.h ?? 0}px`,
        stagger: 0.15,
        duration: 0.5,
        ease: 'power2.out',
      },
    )
      .fromTo('[data-block="4"] [data-top]', IDLE, { ...LIVE, duration: 0.3 }, '+=0.2')
      .to('[data-block="4"] [data-top]', { ...IDLE, duration: 0.3 }, '+=0.5')
      .fromTo('[data-block="3"] [data-top]', IDLE, { ...LIVE, duration: 0.3 }, '<')
      .from('[data-rollback-note]', { opacity: 0, y: 6, duration: 0.3 });
  });
  return (
    <section ref={root} className="relative flex min-h-svh items-center">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center [&>*]:min-w-0">
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
        <div className="relative h-[340px] overflow-hidden [perspective:1200px]">
          <div className="absolute inset-x-6 bottom-10 top-10 [transform:rotateX(55deg)_rotateZ(-35deg)] [transform-style:preserve-3d]">
            <div className="absolute inset-0 rounded-xl border border-line bg-panel/40" />
            {DEPLOYS.map((d, i) => (
              <div
                key={d.n}
                data-block={i}
                className="absolute top-[38%] aspect-square w-[11%] [transform-style:preserve-3d]"
                style={{ left: `${8 + i * 18}%`, '--h': `${d.h}px` } as React.CSSProperties}
              >
                {WALLS.map((w) => (
                  <div
                    key={w.cls}
                    className={`absolute border border-line/70 ${w.cls}`}
                    style={{ background: w.bg }}
                  />
                ))}
                <div
                  data-top
                  className="absolute inset-0 rounded-[3px] border border-line [transform:translateZ(var(--h))]"
                  style={i === LIVE_INDEX ? LIVE : IDLE}
                />
                <div className="absolute left-0 top-[calc(100%+10px)] font-mono text-[10px] text-muted [transform:rotateZ(35deg)_rotateX(-55deg)]">
                  #{d.n}
                </div>
              </div>
            ))}
          </div>
          <p
            data-rollback-note
            className="absolute bottom-0 left-0 right-0 text-center font-mono text-[12px] text-muted"
          >
            rollback #128 → #127 · <span className="text-ok">3.7 ms</span> · nothing rebuilt
          </p>
        </div>
      </div>
    </section>
  );
}

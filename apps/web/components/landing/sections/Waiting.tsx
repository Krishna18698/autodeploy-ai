'use client';

import { useRef } from 'react';
import { useScrollScene } from './useScrollScene';

const LINES = [
  ['$', 'pnpm install --frozen-lockfile', ''],
  ['', 'Packages: +412', 'text-muted'],
  ['', 'Progress: resolved 412, reused 380, downloaded 32', 'text-muted'],
  ['$', 'vite build', ''],
  ['', 'vite v7.3.6 building for production…', 'text-run'],
  ['', '✓ 214 modules transformed.', 'text-ok'],
  ['', 'dist/index.html            0.46 kB │ gzip: 0.30 kB', 'text-muted'],
  ['', 'dist/assets/index-Bgopu29T.js  142.18 kB │ gzip: 45.71 kB', 'text-muted'],
  ['', '✓ built in 1.82s', 'text-ok'],
  ['▸', 'validating in headless Chromium… 200 OK, 0 errors', 'text-run'],
  ['▸', 'live at shop.autodeploy.eu.org', 'text-ok'],
] as const;
const STEPS = ['Analyze', 'Queue', 'Build', 'Validate', 'Live'];

export function Waiting() {
  const root = useRef<HTMLElement>(null);
  useScrollScene(root, (tl) => {
    tl.from('[data-line]', { opacity: 0, y: 8, stagger: 0.3, duration: 0.3 }, 0);
    tl.from(
      '[data-step-fill]',
      { scaleX: 0, transformOrigin: 'left', stagger: 0.7, duration: 0.7 },
      0,
    );
    tl.from('[data-step]', { opacity: 0.25, stagger: 0.7, duration: 0.2 }, 0);
  });
  return (
    <section ref={root} id="how" className="relative flex min-h-dvh items-center">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center [&>*]:min-w-0">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-run">01 · build</p>
          <h2 className="mt-3 text-[clamp(2rem,4.4vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
            Most of a deploy is <span className="font-serif font-normal italic">waiting.</span>
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            So every build streams to you live: queued with fair scheduling, built in a sandbox with
            no network except the package registry, validated in a real browser before anyone sees
            it.
          </p>
          <ol className="mt-8 flex flex-wrap items-center gap-2 font-mono text-[12px]">
            {STEPS.map((s, i) => (
              <li key={s} data-step className="flex items-center gap-2">
                <span className="text-ok">✓</span>
                {s}
                {i < STEPS.length - 1 && (
                  <span className="relative h-px w-8 overflow-hidden bg-line">
                    <span data-step-fill className="absolute inset-0 bg-ok/70" />
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
        <div className="glass overflow-hidden rounded-[10px] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
          <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
            <span className="ml-3 font-mono text-[11px] text-muted">
              shop ▸ deploy #128 ▸ attempt 1 · node 22 · sandbox
            </span>
          </div>
          <pre className="min-h-[300px] overflow-x-auto p-4 font-mono text-[12px] leading-6">
            {LINES.map(([p, t, cls]) => (
              <div key={t} data-line className={cls || 'text-fg/90'}>
                <span className="mr-2 select-none text-muted/60">{p || ' '}</span>
                {t}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </section>
  );
}

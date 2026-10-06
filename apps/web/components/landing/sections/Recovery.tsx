'use client';

import { useRef } from 'react';
import { useScrollScene } from './useScrollScene';

export function Recovery() {
  const root = useRef<HTMLElement>(null);
  useScrollScene(
    root,
    (tl, mobile) => {
      const d = mobile ? 0.4 : 1;
      tl.to('[data-err]', { backgroundColor: 'rgba(244,63,94,0.14)', duration: d })
        .from('[data-sig]', { rotateX: -90, opacity: 0, transformOrigin: 'top', duration: d })
        .from('[data-diag] span', { opacity: 0, stagger: 0.06, duration: d / 4 })
        .from('[data-diff]', { x: 40, opacity: 0, duration: d })
        .from('[data-check]', { opacity: 0, x: -8, stagger: 0.25, duration: d / 2 })
        .to('[data-status]', {
          color: '#34d399',
          borderColor: 'rgba(52,211,153,0.5)',
          duration: d / 2,
        })
        .to('[data-status-fail]', { opacity: 0, duration: d / 4 }, '<')
        .to('[data-status-ok]', { opacity: 1, duration: d / 4 }, '<');
    },
    '+=180%',
  );
  const diagnosis =
    'The prop was renamed to `account` in Props, but Header still reads `user`.'.split(' ');
  return (
    <section ref={root} id="recovery" className="relative flex min-h-svh items-center">
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center [&>*]:min-w-0">
        <div className="order-2 flex flex-col gap-3 lg:order-1 [perspective:900px]">
          <div className="glass rounded-[10px] p-4 font-mono text-[12px]">
            <div className="mb-2 flex items-center justify-between text-muted">
              <span>docs ▸ #131 ▸ attempt 1</span>
              <span
                data-status
                className="rounded-full border border-fail/50 px-2 py-0.5 text-fail"
              >
                ●{' '}
                <span className="relative inline-grid">
                  <span data-status-fail className="[grid-area:1/1]">
                    Build failed
                  </span>
                  <span data-status-ok className="opacity-0 [grid-area:1/1]">
                    Live
                  </span>
                </span>
              </span>
            </div>
            <div className="text-muted">src/Header.tsx(14,31):</div>
            <div data-err className="rounded px-1 text-fail">
              error TS2339: Property &apos;user&apos; does not exist on type &apos;Props&apos;.
            </div>
          </div>
          <div data-sig className="glass rounded-[10px] p-4 font-mono text-[12px]">
            <span className="text-muted">signature </span>
            <span className="text-fg">TS_COMPILE:3fa91c</span>
            <span className="text-muted"> · no rule matches → </span>
            <span className="text-ai">AI diagnosis</span>
          </div>
          <div className="glass rounded-[10px] p-4 text-[13px] leading-relaxed" data-diag>
            {diagnosis.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: words are positional
              <span key={i}>{w} </span>
            ))}
          </div>
          <div
            data-diff
            className="glass overflow-hidden rounded-[10px] font-mono text-[12px] leading-6"
          >
            <div className="border-b border-line px-4 py-2 text-muted">src/Header.tsx · +1 −1</div>
            <div className="break-all bg-fail/10 px-4 text-fail">
              - &lt;Avatar user=&#123;props.user&#125; /&gt;
            </div>
            <div className="break-all bg-ok/10 px-4 text-ok">
              + &lt;Avatar user=&#123;props.account&#125; /&gt;
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-[11px]">
              <span data-check className="text-ok">
                ✓ scope
              </span>
              <span data-check className="text-ok">
                ✓ size
              </span>
              <span data-check className="text-ok">
                ✓ no secrets
              </span>
              <span data-check className="text-ok">
                ✓ rebuilt + validated
              </span>
              <span data-check className="text-warn">
                ⚠ awaiting your approval
              </span>
            </div>
          </div>
        </div>
        <div className="order-1 lg:order-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-run">02 · recover</p>
          <h2 className="mt-3 text-[clamp(2rem,4.4vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
            Failures, <span className="font-serif font-normal italic">handled.</span>
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Known failures are fixed by deterministic rules in seconds — wrong Node version, wrong
            output folder, stale lockfile. The rest go to a model that proposes the smallest patch,
            which is policy-checked, rebuilt in a fresh sandbox and validated before you ever see
            it. Nothing touches your main branch without you.
          </p>
        </div>
      </div>
    </section>
  );
}

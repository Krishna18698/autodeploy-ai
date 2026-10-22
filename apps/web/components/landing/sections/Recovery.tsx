import type { ReactNode } from 'react';
import { FadeIn, SectionHead } from '../FadeIn';

// One repair, told the way the dashboard's Recovery tab shows it: what broke,
// what the AI found, the fix it tested, and the approval it waits for.
type Tone = 'fail' | 'ai' | 'ok' | 'warn';
const DOT: Record<Tone, string> = {
  fail: 'bg-fail',
  ai: 'bg-ai',
  ok: 'bg-ok',
  warn: 'bg-warn animate-[pulse-dot_1.4s_ease-in-out_infinite]',
};
const RING: Record<Tone, string> = {
  fail: 'border-fail/50',
  ai: 'border-ai/50',
  ok: 'border-ok/40',
  warn: 'border-warn/50',
};

function Step({
  tone,
  title,
  meta,
  last = false,
  children,
}: {
  tone: Tone;
  title: string;
  meta: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3">
      {!last && <span aria-hidden className="absolute -bottom-5 left-[11px] top-7 w-px bg-line" />}
      <span
        className={`relative grid size-6 place-items-center rounded-full border ${RING[tone]} bg-bg/60`}
      >
        <span className={`size-2 rounded-full ${DOT[tone]}`} />
      </span>
      <div>
        <div className="flex min-h-6 items-center justify-between gap-3">
          <span className="text-[13px] font-medium">{title}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted">{meta}</span>
        </div>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}

const code = 'font-mono text-[12px] text-fg';

export function Recovery() {
  return (
    <section id="recovery" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center [&>*]:min-w-0">
        <FadeIn className="order-2 lg:order-1">
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgb(192_132_252/0.12),transparent)] blur-2xl"
            />
            <div className="glass relative rounded-2xl bg-panel/80 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
              <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
                <span className="truncate">
                  docs <span className="text-fg/60">▸</span> deploy #131
                </span>
                <span className="shrink-0 rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-warn">
                  waiting for approval
                </span>
              </div>

              <ol className="mt-5 grid gap-5">
                <Step tone="fail" title="Build failed" meta="attempt 1">
                  <div className="rounded-lg border border-fail/25 bg-fail/[0.06] px-3 py-2 font-mono text-[11px] leading-5">
                    <div className="text-muted">src/Header.tsx, line 14</div>
                    <div className="text-fail">
                      Property &apos;user&apos; does not exist on type &apos;Props&apos;
                    </div>
                  </div>
                </Step>

                <Step tone="ai" title="No known fix, so the AI looked" meta="6 s">
                  <p className="text-[13px] leading-relaxed text-fg/80">
                    The prop was renamed to <code className={code}>account</code>, but{' '}
                    <code className={code}>Header</code> still reads{' '}
                    <code className={code}>user</code>.
                  </p>
                </Step>

                <Step tone="ok" title="Fix tested in a fresh build" meta="attempt 2 · 38 s">
                  <div className="overflow-hidden rounded-lg border border-line font-mono text-[11px] leading-6">
                    <div className="border-b border-line px-3 text-muted">src/Header.tsx</div>
                    <div className="whitespace-pre-wrap break-words bg-fail/10 px-3 text-fail">
                      − &lt;Avatar user=&#123;props.user&#125; /&gt;
                    </div>
                    <div className="whitespace-pre-wrap break-words bg-ok/10 px-3 text-ok">
                      + &lt;Avatar user=&#123;props.account&#125; /&gt;
                    </div>
                  </div>
                  <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ok">
                    <li>✓ Builds</li>
                    <li>✓ Page loads with no errors</li>
                    <li>✓ Only your source code changed</li>
                  </ul>
                </Step>

                <Step tone="warn" title="Waiting for you" meta="now" last>
                  <div aria-hidden className="flex flex-wrap gap-2">
                    <span className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg">
                      Approve &amp; deploy
                    </span>
                    <span className="rounded-md border border-white/10 bg-white/4 px-3 py-1.5 text-[12px] text-fg/90">
                      Open a pull request
                    </span>
                  </div>
                </Step>
              </ol>
            </div>
          </div>
        </FadeIn>
        <div className="order-1 lg:order-2">
          <SectionHead
            eyebrow="Recovery"
            title="Failures, handled."
            sub="Known failures are fixed by rules in seconds: wrong Node version, wrong output folder, a stale lockfile. The rest go to a model that proposes the smallest patch, checked, rebuilt in a fresh sandbox and validated before you see it. Nothing reaches your code without your approval."
          />
        </div>
      </div>
    </section>
  );
}

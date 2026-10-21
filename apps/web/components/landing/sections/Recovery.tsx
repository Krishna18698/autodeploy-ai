import { FadeIn, SectionHead } from '../FadeIn';

const CHECKS = ['scope', 'size', 'no secrets', 'rebuilt + validated'];

export function Recovery() {
  return (
    <section id="recovery" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center [&>*]:min-w-0">
        <div className="order-2 flex flex-col gap-3 lg:order-1">
          <FadeIn>
            <div className="glass rounded-2xl bg-panel/80 p-4 font-mono text-[12px]">
              <div className="mb-2 flex items-center justify-between gap-3 text-muted">
                <span className="truncate">docs ▸ #131 ▸ attempt 1</span>
                <span className="shrink-0 rounded-full border border-fail/40 bg-fail/10 px-2 py-0.5 text-fail">
                  ● Build failed
                </span>
              </div>
              <div className="text-muted">src/Header.tsx(14,31):</div>
              <div className="rounded bg-fail/10 px-1 text-fail">
                error TS2339: Property &apos;user&apos; does not exist on type &apos;Props&apos;.
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={80}>
            <div className="glass rounded-2xl bg-panel/80 p-4 font-mono text-[12px]">
              <span className="text-muted">signature </span>
              <span className="text-fg">TS_COMPILE:3fa91c</span>
              <span className="text-muted"> · no rule matches → </span>
              <span className="text-ai">AI diagnosis</span>
            </div>
          </FadeIn>
          <FadeIn delay={160}>
            <div className="glass rounded-2xl bg-panel/80 p-4 text-[14px] leading-relaxed text-fg/90">
              The prop was renamed to <code className="font-mono text-[12px]">account</code> in
              Props, but Header still reads <code className="font-mono text-[12px]">user</code>.
            </div>
          </FadeIn>
          <FadeIn delay={240}>
            <div className="glass overflow-hidden rounded-2xl bg-panel/80 font-mono text-[12px] leading-6">
              <div className="border-b border-white/6 px-4 py-2 text-muted">
                src/Header.tsx · +1 −1
              </div>
              <div className="break-all bg-fail/10 px-4 text-fail">
                - &lt;Avatar user=&#123;props.user&#125; /&gt;
              </div>
              <div className="break-all bg-ok/10 px-4 text-ok">
                + &lt;Avatar user=&#123;props.account&#125; /&gt;
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-[11px]">
                {CHECKS.map((c) => (
                  <span key={c} className="text-ok">
                    ✓ {c}
                  </span>
                ))}
                <span className="text-warn">● awaiting your approval</span>
              </div>
            </div>
          </FadeIn>
        </div>
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

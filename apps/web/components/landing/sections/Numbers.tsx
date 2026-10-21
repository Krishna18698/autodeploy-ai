import { MEASURED } from '@/lib/measured';
import { FadeIn, SectionHead } from '../FadeIn';

export function Numbers() {
  return (
    <section id="numbers" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <SectionHead
        eyebrow="Numbers"
        title="Measured, not promised."
        sub="Each figure comes from a test or a run you can reproduce from the repository."
      />
      <FadeIn delay={100}>
        <dl className="glass mt-12 grid overflow-hidden rounded-2xl sm:grid-cols-2 lg:grid-cols-4">
          {MEASURED.map((m, i) => (
            <div
              key={m.label}
              className={`p-6 ${i > 0 ? 'border-t border-white/6 sm:border-t-0' : ''} ${
                i % 2 === 1 ? 'sm:border-l sm:border-white/6' : ''
              } ${i >= 2 ? 'sm:border-t sm:border-white/6 lg:border-t-0' : ''} ${
                i % 4 !== 0 ? 'lg:border-l lg:border-white/6' : ''
              }`}
            >
              <dt className="text-[13px] text-muted">{m.label}</dt>
              <dd className="mt-3 text-[clamp(2.2rem,3.6vw,3rem)] font-semibold tracking-tight tabular-nums">
                {m.value.toFixed(m.decimals)}
                <span className="ml-1 text-[0.45em] font-normal text-muted">{m.unit}</span>
              </dd>
              <dd className="mt-2 text-[13px] leading-relaxed text-muted">{m.detail}</dd>
            </div>
          ))}
        </dl>
      </FadeIn>
    </section>
  );
}

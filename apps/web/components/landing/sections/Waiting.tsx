import { FadeIn, SectionHead } from '../FadeIn';

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
  ['▸', 'live at shop.autodeploy.fyi', 'text-ok'],
] as const;
const STEPS = ['Analyze', 'Queue', 'Build', 'Validate', 'Live'];

export function Waiting() {
  return (
    <section id="how" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center [&>*]:min-w-0">
        <div>
          <SectionHead
            eyebrow="Builds"
            title="Watch every build as it happens."
            sub="Logs stream to your browser live. Builds are queued fairly, run in a sandbox with no network except the package registry, and are checked in a real browser before anyone sees them."
          />
          <FadeIn delay={100}>
            <ol className="mt-8 flex flex-wrap gap-2 text-[13px]">
              {STEPS.map((s) => (
                <li
                  key={s}
                  className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/3 px-3 py-1 text-fg/90"
                >
                  <span className="text-ok">✓</span>
                  {s}
                </li>
              ))}
            </ol>
          </FadeIn>
        </div>
        <FadeIn delay={120}>
          <div className="glass overflow-hidden rounded-2xl bg-panel/80 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
            <div className="flex items-center gap-1.5 border-b border-white/6 px-4 py-3">
              <span className="size-2.5 rounded-full bg-white/10" />
              <span className="size-2.5 rounded-full bg-white/10" />
              <span className="size-2.5 rounded-full bg-white/10" />
              <span className="ml-3 truncate font-mono text-[11px] text-muted">
                shop ▸ deploy #128 ▸ attempt 1 · node 22 · sandbox
              </span>
            </div>
            {/* Phones wrap long lines (with a hanging indent) instead of cutting them off. */}
            <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6 sm:text-[12px]">
              {LINES.map(([p, t, cls]) => (
                <div
                  key={t}
                  className={`whitespace-pre-wrap break-words pl-[2ch] -indent-[2ch] sm:whitespace-pre ${cls || 'text-fg/90'}`}
                >
                  <span className="mr-2 select-none text-muted/60">{p || ' '}</span>
                  {t}
                </div>
              ))}
            </pre>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

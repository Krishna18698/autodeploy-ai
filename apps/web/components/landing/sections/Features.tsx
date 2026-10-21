import { FadeIn, SectionHead } from '../FadeIn';

// Stroke icons drawn on a 20px grid, same weight as the type.
const ICON: Record<string, string> = {
  detect: 'M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM13 13l3.5 3.5',
  sandbox: 'M10 2.5 3.5 6v8L10 17.5l6.5-3.5V6L10 2.5ZM3.5 6 10 9.5 16.5 6M10 9.5v8',
  rules: 'M4 10.5 8 14.5 16 5.5',
  ai: 'M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M5 5l2 2M13 13l2 2M15 5l-2 2M7 13l-2 2',
  server: 'M3.5 4h13v5h-13zM3.5 11h13v5h-13zM6.5 6.5h.01M6.5 13.5h.01',
  rollback: 'M4 10a6 6 0 1 0 2-4.5M4 3.5v3h3',
};

const FEATURES = [
  [
    'detect',
    'Detects your setup',
    'Framework, package manager, Node version, build command and output folder, each with the evidence it came from.',
  ],
  [
    'sandbox',
    'Builds in a sandbox',
    'Every build runs in a fresh gVisor container with no network except the package registries.',
  ],
  [
    'rules',
    'Fixes known failures',
    'Wrong Node version, wrong output folder, a stale lockfile: rules fix them in seconds, without AI.',
  ],
  [
    'ai',
    'AI patches you approve',
    'When rules can’t help, a model proposes the smallest change, rebuilt and tested before you see it.',
  ],
  [
    'server',
    'Server-rendered apps',
    'Next.js, Nuxt, SvelteKit, Astro, Remix or any Node server. They sleep when idle and wake on the next visit.',
  ],
  [
    'rollback',
    'Instant rollback',
    'Every build is kept. Going back moves one pointer at the edge: no rebuild, no downtime.',
  ],
] as const;

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <SectionHead
        eyebrow="Features"
        title="Everything between git push and live."
        sub="AutoDeploy reads your repository instead of asking you to configure it, and tells you what it decided and why."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(([icon, title, text], i) => (
          <FadeIn key={title} delay={(i % 3) * 80}>
            <div className="glass group flex h-full gap-4 rounded-2xl p-5 transition-colors hover:bg-white/4 sm:block sm:p-6">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/8 bg-white/4 text-fg/80">
                <svg viewBox="0 0 20 20" className="size-[18px]" aria-hidden>
                  <path
                    d={ICON[icon]}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <h3 className="text-[15px] font-medium text-fg sm:mt-5">{title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted sm:mt-2">{text}</p>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </section>
  );
}

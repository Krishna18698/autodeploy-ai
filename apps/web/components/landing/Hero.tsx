import Link from 'next/link';
import { DemoVideo } from './DemoVideo';
import { HeroCard } from './HeroCard';

export function Hero() {
  return (
    <section className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-16 pt-32 sm:px-6 lg:grid-cols-[1fr_1fr] lg:pb-24 lg:pt-40">
      <div className="animate-[rise_0.9s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none">
        <a
          href="#features"
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/3 py-1 pl-1 pr-3 text-[12px] text-muted transition-colors hover:text-fg"
        >
          <span className="rounded-full bg-run/15 px-2 py-0.5 font-medium text-run">
            Portfolio project
          </span>
          Static sites and server-rendered apps
          <span aria-hidden>→</span>
        </a>
        <h1 className="text-[clamp(2.6rem,6vw,4.6rem)] font-semibold leading-[1.02] tracking-[-0.04em]">
          Deploys that fix <span className="text-muted">themselves.</span>
        </h1>
        <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-muted">
          Connect a repository. AutoDeploy works out how to build it, runs it in a sandbox, repairs
          the failures it understands and shows you every decision it made.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="inline-flex h-11 items-center rounded-lg bg-fg px-5 text-[14px] font-medium text-bg shadow-[0_1px_0_rgb(255_255_255/0.3)_inset] transition-colors hover:bg-fg/90"
          >
            Try the live demo
          </Link>
          <DemoVideo />
        </div>
        <p className="mt-6 text-[13px] text-muted">
          Sign in to look around real deploys · Deploying your own by approval
        </p>
      </div>
      <div className="animate-[rise_1.1s_0.15s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none lg:justify-self-end">
        <HeroCard />
      </div>
    </section>
  );
}

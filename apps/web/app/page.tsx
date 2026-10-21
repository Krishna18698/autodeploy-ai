import { Hero } from '@/components/landing/Hero';
import { Nav } from '@/components/landing/Nav';
import { Architecture } from '@/components/landing/sections/Architecture';
import { Closing } from '@/components/landing/sections/Closing';
import { Features } from '@/components/landing/sections/Features';
import { Numbers } from '@/components/landing/sections/Numbers';
import { Recovery } from '@/components/landing/sections/Recovery';
import { Waiting } from '@/components/landing/sections/Waiting';

export default function Landing() {
  return (
    <>
      {/* A soft light from above, and a faint grid that fades out below the hero. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[900px] overflow-hidden"
      >
        <div className="absolute left-1/2 top-[-280px] h-[620px] w-[min(1100px,140vw)] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(122_162_255/0.16),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000,transparent)]" />
      </div>
      <Nav />
      <main className="relative overflow-x-clip">
        <Hero />
        <Features />
        <Waiting />
        <Recovery />
        <Numbers />
        <Architecture />
        <Closing />
      </main>
    </>
  );
}

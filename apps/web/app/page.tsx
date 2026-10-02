import { Cursor } from '@/components/landing/Cursor';
import { Hero } from '@/components/landing/Hero';
import { Nav } from '@/components/landing/Nav';
import { RibbonCanvas } from '@/components/landing/RibbonCanvas';
import { SmoothScroll } from '@/components/landing/SmoothScroll';

export default function Landing() {
  return (
    <>
      <SmoothScroll />
      <RibbonCanvas />
      <Cursor />
      <Nav />
      <main>
        <Hero />
        {/* Placeholder so scroll-linked ribbon drift is visible in the prototype. */}
        <section id="how" className="mx-auto flex min-h-[80vh] max-w-7xl items-center px-4 sm:px-6">
          <h2 className="text-[clamp(2rem,4.5vw,3.5rem)] font-semibold tracking-[-0.03em]">
            Most of a deploy is <span className="font-serif font-normal italic">waiting.</span>
          </h2>
        </section>
      </main>
    </>
  );
}

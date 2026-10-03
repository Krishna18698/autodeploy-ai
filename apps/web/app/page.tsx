import { Cursor } from '@/components/landing/Cursor';
import { Hero } from '@/components/landing/Hero';
import { Nav } from '@/components/landing/Nav';
import { RibbonCanvas } from '@/components/landing/RibbonCanvas';
import { SmoothScroll } from '@/components/landing/SmoothScroll';
import { Architecture } from '@/components/landing/sections/Architecture';
import { Closing } from '@/components/landing/sections/Closing';
import { Numbers } from '@/components/landing/sections/Numbers';
import { Record } from '@/components/landing/sections/Record';
import { Recovery } from '@/components/landing/sections/Recovery';
import { Waiting } from '@/components/landing/sections/Waiting';
import { Wipe } from '@/components/landing/sections/Wipe';

export default function Landing() {
  return (
    <>
      <SmoothScroll />
      <RibbonCanvas />
      <Cursor />
      <Nav />
      {/* Scroll scenes animate in from offsets; clip so they never widen the page. */}
      <main className="overflow-x-clip">
        <Hero />
        <Waiting />
        <Recovery />
        <Record />
        <Wipe />
        <Numbers />
        <Architecture />
        <Closing />
      </main>
    </>
  );
}

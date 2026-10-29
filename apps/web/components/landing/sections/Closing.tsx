import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { LEGAL_PAGES } from '@/lib/legal';

export function Closing() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6">
        <div className="glass relative overflow-hidden rounded-3xl px-6 py-16 text-center sm:px-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-xl rounded-full bg-[radial-gradient(closest-side,rgb(122_162_255/0.22),transparent)] blur-2xl"
          />
          <h2 className="relative mx-auto max-w-2xl text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            Ship something broken.
          </h2>
          <p className="relative mx-auto mt-4 max-w-lg text-[16px] leading-relaxed text-muted">
            We&apos;ll tell you why, and most of the time fix it before you notice.
          </p>
          <div className="relative mt-9 flex flex-wrap justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex h-11 items-center rounded-lg bg-fg px-5 text-[14px] font-medium text-bg shadow-[0_1px_0_rgb(255_255_255/0.3)_inset] transition-colors hover:bg-fg/90"
            >
              Try the live demo
            </Link>
            <a
              href="#how"
              className="inline-flex h-11 items-center rounded-lg border border-white/8 bg-white/4 px-5 text-[14px] text-fg transition-colors hover:bg-white/7"
            >
              See how it works
            </a>
          </div>
        </div>
      </section>
      {/* Only what someone looks for at the bottom of a page: a way in, the API,
          and the legal pages (which sign-in providers also expect to find). */}
      <footer className="border-t border-white/6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-[13px] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-4">
            <Logo />
            <span className="text-[12px] text-muted">© {new Date().getFullYear()}</span>
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {[
                ['Sign in', '/login'],
                ['API reference', 'https://api.autodeploy.fyi/docs'],
                ...LEGAL_PAGES,
              ].map(([label, href]) => (
                <li key={label}>
                  <a href={href} className="text-muted transition-colors hover:text-fg">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </>
  );
}

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
              Start deploying
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
      <footer className="border-t border-white/6">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 text-[13px] sm:grid-cols-2 sm:px-6 lg:grid-cols-5">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-muted">
              Self-healing deployments for static sites and server-rendered apps.
            </p>
          </div>
          {[
            [
              'Product',
              [
                ['Features', '#features'],
                ['How it works', '#how'],
                ['Recovery', '#recovery'],
                ['Numbers', '#numbers'],
              ],
            ],
            [
              'Engineering',
              [
                ['Under the hood', '#architecture'],
                ['API reference', 'https://api.autodeploy.fyi/docs'],
              ],
            ],
            [
              'Project',
              [
                ['Dashboard', '/overview'],
                ['Sign in', '/login'],
                ['GitHub', 'https://github.com/Krishna18698'],
              ],
            ],
            ['Legal', LEGAL_PAGES.map(([label, href]) => [label, href])],
          ].map(([title, links]) => (
            <div key={title as string}>
              <div className="text-[13px] font-medium text-fg">{title as string}</div>
              <ul className="mt-3 flex flex-col gap-2">
                {(links as string[][]).map(([l, h]) => (
                  <li key={l}>
                    <a href={h} className="text-muted transition-colors hover:text-fg">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-8 text-[12px] text-muted sm:px-6">
          © {new Date().getFullYear()} AutoDeploy
        </div>
      </footer>
    </>
  );
}

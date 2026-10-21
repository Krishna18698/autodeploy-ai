import Link from 'next/link';
import { LEGAL_PAGES } from '@/lib/legal';

export function Closing() {
  return (
    <>
      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="relative overflow-hidden rounded-[16px] border border-run/30 bg-gradient-to-br from-run/15 via-panel to-ok/10 p-8 sm:p-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-run/20 blur-3xl"
          />
          <h2 className="max-w-2xl text-[clamp(2rem,4.6vw,3.8rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
            Ship something <span className="font-serif font-normal italic">broken.</span>
          </h2>
          <p className="mt-4 max-w-lg text-[15px] text-muted">
            We&apos;ll tell you why — and most of the time, fix it before you notice.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-full bg-run px-5 py-2.5 text-sm font-medium text-bg transition-transform hover:scale-[1.03]"
            >
              Connect GitHub
            </Link>
            <a
              href="#architecture"
              className="rounded-full border border-line bg-bg/40 px-5 py-2.5 text-sm text-fg hover:border-muted"
            >
              Read the architecture
            </a>
          </div>
        </div>
      </section>
      <footer className="border-t border-line">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 text-[13px] sm:grid-cols-2 sm:px-6 lg:grid-cols-5">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <span
                aria-hidden
                className="grid size-5 place-items-center rounded-[5px] bg-run text-[11px] text-bg"
              >
                ◆
              </span>
              AutoDeploy
            </div>
            <p className="mt-3 max-w-xs text-muted">
              Self-healing deployments for static sites and server-rendered apps.
            </p>
          </div>
          {[
            [
              'Product',
              [
                ['How it works', '#how'],
                ['Recovery', '#recovery'],
                ['Numbers', '#numbers'],
              ],
            ],
            [
              'Engineering',
              [
                ['Architecture', '#architecture'],
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
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                {title as string}
              </div>
              <ul className="mt-3 flex flex-col gap-2">
                {(links as string[][]).map(([l, h]) => (
                  <li key={l}>
                    <a href={h} className="text-fg/80 hover:text-fg">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-8 font-mono text-[11px] text-muted sm:px-6">
          © {new Date().getFullYear()} AutoDeploy
        </div>
      </footer>
    </>
  );
}

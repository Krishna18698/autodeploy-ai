import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { LEGAL, LEGAL_PAGES } from '@/lib/legal';

// Plain reading pages: no scroll effects, readable line length, and the same
// header and footer on each so people can move between the policies.
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-white/6">
        <nav className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link href="/" aria-label="AutoDeploy home">
            <Logo />
          </Link>
          <Link href="/login" className="text-[13px] text-muted hover:text-fg">
            Sign in
          </Link>
        </nav>
      </header>
      <main className="legal mx-auto max-w-3xl px-4 py-10 text-[15px] leading-7 text-fg/90 sm:px-6 sm:py-14">
        {children}
      </main>
      <footer className="border-t border-white/6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-[13px] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {LEGAL_PAGES.map(([label, href]) => (
              <li key={href}>
                <Link href={href} className="text-muted hover:text-fg">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
          <span className="font-mono text-[11px] text-muted">
            © {new Date().getFullYear()} {LEGAL.operator}
          </span>
        </div>
      </footer>
    </>
  );
}

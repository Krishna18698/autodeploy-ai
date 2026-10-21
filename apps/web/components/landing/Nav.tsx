import Link from 'next/link';
import { Logo } from '@/components/ui/logo';

const LINKS = [
  ['Features', '#features'],
  ['Recovery', '#recovery'],
  ['Numbers', '#numbers'],
  ['Under the hood', '#architecture'],
] as const;

export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/6 bg-bg/80 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="AutoDeploy home">
          <Logo />
        </Link>
        <ul className="hidden items-center gap-7 text-[13px] text-muted md:flex">
          {LINKS.map(([label, href]) => (
            <li key={href}>
              <a className="transition-colors hover:text-fg" href={href}>
                {label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden h-9 items-center rounded-lg px-3 text-[13px] text-muted transition-colors hover:text-fg sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-lg bg-fg px-3.5 text-[13px] font-medium text-bg transition-colors hover:bg-fg/90"
          >
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}

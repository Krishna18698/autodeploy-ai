export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-line/40 bg-bg">
      <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid size-5 place-items-center rounded-[5px] bg-run text-[11px] text-bg"
          >
            ◆
          </span>
          AutoDeploy
        </a>
        <ul className="hidden items-center gap-7 text-[13px] text-muted md:flex">
          <li>
            <a className="transition-colors hover:text-fg" href="#how">
              How it works
            </a>
          </li>
          <li>
            <a className="transition-colors hover:text-fg" href="#recovery">
              Recovery
            </a>
          </li>
          <li>
            <a className="transition-colors hover:text-fg" href="#numbers">
              Numbers
            </a>
          </li>
          <li>
            <a className="transition-colors hover:text-fg" href="#architecture">
              Architecture
            </a>
          </li>
        </ul>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-full border border-line bg-panel/60 px-2.5 py-1 font-mono text-[11px] text-muted sm:flex">
            <span className="size-1.5 rounded-full bg-ok" />
            all systems normal
          </span>
          <a
            href="/login"
            className="rounded-full bg-run px-3.5 py-1.5 text-[13px] font-medium text-bg transition-transform hover:scale-[1.03] active:scale-[0.98]"
          >
            Start free
          </a>
        </div>
      </nav>
    </header>
  );
}

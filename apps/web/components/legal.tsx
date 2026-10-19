import { LEGAL } from '@/lib/legal';

export function LegalTitle({ title, intro }: { title: string; intro: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="text-[28px] font-semibold tracking-tight text-fg sm:text-[34px]">{title}</h1>
      <p className="mt-2 font-mono text-[12px] text-muted">Effective {LEGAL.effective}</p>
      <p className="mt-6 text-fg/90">{intro}</p>
    </div>
  );
}

/** The public contact address as a link (or a note while it isn't set). */
export function Contact() {
  if (!LEGAL.email) return <span>the contact address (being set up)</span>;
  return (
    <a href={`mailto:${LEGAL.email}`} className="text-run underline-offset-2 hover:underline">
      {LEGAL.email}
    </a>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-bg font-mono text-[12px] leading-[1.7]">
      {lines.map((l, i) => {
        const cls =
          l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git')
            ? 'text-muted'
            : l.startsWith('@@')
              ? 'bg-run/5 text-run/80'
              : l.startsWith('+')
                ? 'bg-ok/10 text-ok'
                : l.startsWith('-')
                  ? 'bg-fail/10 text-fail'
                  : 'text-fg/80';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          <div key={i} className={`whitespace-pre px-3 ${cls}`}>
            {l || ' '}
          </div>
        );
      })}
    </div>
  );
}

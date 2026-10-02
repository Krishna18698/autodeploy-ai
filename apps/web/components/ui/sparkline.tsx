// Trend sparkline: the history in a recessive gray, the latest point in the accent.
export function Sparkline({
  values,
  width = 72,
  height = 20,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2)
    return <span className="inline-block font-mono text-[11px] text-muted/50">—</span>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map(
    (v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as const,
  );
  const last = pts.at(-1) ?? [0, 0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `trend, latest ${values.at(-1)}`}
      className="overflow-visible"
    >
      <polyline
        points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
        fill="none"
        stroke="var(--color-chart-muted)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r="4"
        fill="var(--color-chart-1)"
        stroke="var(--color-panel)"
        strokeWidth="2"
      />
    </svg>
  );
}

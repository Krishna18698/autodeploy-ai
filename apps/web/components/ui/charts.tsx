'use client';

import { useId, useState } from 'react';

// Charts built to the dataviz spec: ≤24px columns with 4px rounded data
// ends, a 2px surface gap between stacked segments, 2px lines, hairline
// solid grid, a legend for ≥2 series, sparing direct labels, hover + focus
// tooltips (values lead), and a table view so nothing is gated on hover.

type Tip = {
  x: number | string;
  y: number;
  title: string;
  rows: Array<{ label: string; value: string; color: string }>;
} | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-raised/95 px-3 py-2 text-[12px] shadow-xl backdrop-blur"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <div className="mb-1 font-mono text-[11px] text-muted">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: r.color }} />
          <span className="font-semibold tabular-nums text-fg">{r.value}</span>
          <span className="text-muted">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

export type Series = { key: string; label: string; color: string };

export function StackedColumns({
  data,
  series,
  xKey,
  height = 180,
  formatX = (x) => x,
  ariaLabel,
}: {
  data: Array<Record<string, number | string>>;
  series: Series[];
  xKey: string;
  height?: number;
  formatX?: (x: string) => string;
  ariaLabel: string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const totals = data.map((d) => series.reduce((s, k) => s + Number(d[k.key] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const w = 640;
  const padL = 32;
  const padB = 22;
  const padT = 18; // room for the peak's direct label
  const plotH = height - padB - padT;
  const band = (w - padL) / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.6);
  const peak = totals.indexOf(Math.max(...totals));
  const ticks = [0, max / 2, max];

  return (
    <figure aria-labelledby={`${id}-cap`} className="relative">
      <figcaption id={`${id}-cap`} className="sr-only">
        {ariaLabel}
      </figcaption>
      <Legend series={series} onTable={() => setTable((t) => !t)} table={table} />
      {table ? (
        <DataTable
          rows={data.map((d) => [
            formatX(String(d[xKey])),
            ...series.map((s) => String(d[s.key] ?? 0)),
          ])}
          head={['Day', ...series.map((s) => s.label)]}
        />
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${w} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={ariaLabel}
            onPointerLeave={() => setTip(null)}
          >
            {ticks.map((t) => {
              const y = padT + plotH - (t / max) * plotH;
              return (
                <g key={t}>
                  <line x1={padL} x2={w} y1={y} y2={y} stroke="var(--color-grid)" strokeWidth="1" />
                  <text
                    x={padL - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-muted font-mono text-[10px]"
                  >
                    {t.toLocaleString()}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const cx = padL + band * i + band / 2;
              let acc = 0;
              const segs = series.map((s) => {
                const v = Number(d[s.key] ?? 0);
                const y0 = acc;
                acc += v;
                return { s, v, y0 };
              });
              const showTip = () =>
                setTip({
                  x: (cx / w) * 100 > 85 ? cx - 40 : cx,
                  y: padT + plotH - (acc / max) * plotH,
                  title: formatX(String(d[xKey])),
                  rows: [...segs].reverse().map(({ s, v }) => ({
                    label: s.label,
                    value: v.toLocaleString(),
                    color: s.color,
                  })),
                });
              return (
                // biome-ignore lint/a11y/useSemanticElements: an SVG group is the hit target for one column
                <g
                  key={String(d[xKey])}
                  tabIndex={0}
                  role="button"
                  aria-label={`${formatX(String(d[xKey]))}: ${segs.map((x) => `${x.v} ${x.s.label}`).join(', ')}`}
                  onPointerEnter={showTip}
                  onFocus={showTip}
                  onBlur={() => setTip(null)}
                  className="outline-none focus-visible:[&>rect.hit]:stroke-run"
                >
                  <rect
                    className="hit"
                    x={padL + band * i}
                    y={padT}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    strokeWidth="1"
                  />
                  {segs.map(({ s, v, y0 }, si) => {
                    if (v === 0) return null;
                    const top = padT + plotH - ((y0 + v) / max) * plotH;
                    const h = (v / max) * plotH - (si > 0 ? 2 : 0); // 2px surface gap between segments
                    const isTop = segs.slice(si + 1).every((x) => x.v === 0);
                    const r = isTop ? Math.min(4, h / 2, barW / 2) : 0;
                    return (
                      <path
                        key={s.key}
                        d={`M${cx - barW / 2},${top + h} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${top + h} Z`}
                        fill={s.color}
                        className="transition-opacity group-hover:opacity-90"
                      />
                    );
                  })}
                  {i === peak && (totals[i] ?? 0) > 0 ? (
                    <text
                      x={cx}
                      y={padT + plotH - ((totals[i] ?? 0) / max) * plotH - 6}
                      textAnchor="middle"
                      className="fill-fg font-mono text-[10px]"
                    >
                      {totals[i]}
                    </text>
                  ) : null}
                  {(i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0) && (
                    <text
                      x={cx}
                      y={height - 6}
                      textAnchor={
                        i === 0 && data.length > 1
                          ? 'start'
                          : i === data.length - 1 && data.length > 1
                            ? 'end'
                            : 'middle'
                      }
                      className="fill-muted font-mono text-[10px]"
                    >
                      {formatX(String(d[xKey]))}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <Tooltip tip={tip ? { ...tip, x: `${(Number(tip.x) / w) * 100}%` } : null} />
        </div>
      )}
    </figure>
  );
}

export function LineChart({
  data,
  xKey,
  yKey,
  label,
  formatY = (v) => v.toLocaleString(),
  formatX = (x) => x,
  height = 160,
}: {
  data: Array<Record<string, number | string | null>>;
  xKey: string;
  yKey: string;
  label: string;
  formatY?: (v: number) => string;
  formatX?: (x: string) => string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pts = data.map((d, i) => ({
    i,
    x: String(d[xKey]),
    y: d[yKey] == null ? null : Number(d[yKey]),
  }));
  const ys = pts.map((p) => p.y).filter((y): y is number => y !== null);
  const w = 640;
  const padL = 44;
  const padB = 22;
  const plotH = height - padB - 10;
  const max = niceMax(Math.max(1, ...ys));
  const sx = (i: number) =>
    data.length <= 1 ? padL + (w - padL) / 2 : padL + (i / (data.length - 1)) * (w - padL - 8);
  const sy = (v: number) => 10 + plotH - (v / max) * plotH;
  const path = pts
    .filter((p) => p.y !== null)
    .map((p, k) => `${k === 0 ? 'M' : 'L'}${sx(p.i).toFixed(1)},${sy(p.y as number).toFixed(1)}`)
    .join(' ');
  const last = [...pts].reverse().find((p) => p.y !== null);
  const h = hover !== null ? pts[hover] : null;

  return (
    <figure className="relative">
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setTable((t) => !t)}
          className="font-mono text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          {table ? 'chart' : 'table'}
        </button>
      </div>
      {table ? (
        <DataTable
          rows={pts.map((p) => [formatX(p.x), p.y === null ? '—' : formatY(p.y)])}
          head={['Day', label]}
        />
      ) : ys.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-muted">No builds in this range yet.</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${w} ${height}`}
            className="h-auto w-full touch-none"
            role="img"
            aria-label={`${label} by day`}
            onPointerMove={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * w;
              const i = Math.round(((x - padL) / (w - padL - 8)) * (data.length - 1));
              setHover(Math.max(0, Math.min(data.length - 1, i)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {[0, max / 2, max].map((t) => (
              <g key={t}>
                <line
                  x1={padL}
                  x2={w}
                  y1={sy(t)}
                  y2={sy(t)}
                  stroke="var(--color-grid)"
                  strokeWidth="1"
                />
                <text
                  x={padL - 6}
                  y={sy(t) + 3}
                  textAnchor="end"
                  className="fill-muted font-mono text-[10px]"
                >
                  {formatY(t)}
                </text>
              </g>
            ))}
            <path
              d={path}
              fill="none"
              stroke="var(--color-chart-1)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {last && last.y !== null && (
              <>
                <circle
                  cx={sx(last.i)}
                  cy={sy(last.y)}
                  r="4"
                  fill="var(--color-chart-1)"
                  stroke="var(--color-panel)"
                  strokeWidth="2"
                />
                <text
                  x={sx(last.i) + (sx(last.i) < w / 2 ? 10 : -10)}
                  y={sy(last.y) - 10}
                  textAnchor={sx(last.i) < w / 2 ? 'start' : 'end'}
                  className="fill-fg font-mono text-[10px]"
                >
                  {formatY(last.y)}
                </text>
              </>
            )}
            {h && (
              <line
                x1={sx(h.i)}
                x2={sx(h.i)}
                y1={10}
                y2={10 + plotH}
                stroke="var(--color-muted)"
                strokeOpacity="0.5"
                strokeWidth="1"
              />
            )}
            {pts.map((p) =>
              p.i === 0 || p.i === pts.length - 1 || p.i % Math.ceil(pts.length / 6) === 0 ? (
                <text
                  key={p.x}
                  x={sx(p.i)}
                  y={height - 6}
                  textAnchor={
                    pts.length > 1 && p.i === 0
                      ? 'start'
                      : pts.length > 1 && p.i === pts.length - 1
                        ? 'end'
                        : 'middle'
                  }
                  className="fill-muted font-mono text-[10px]"
                >
                  {formatX(p.x)}
                </text>
              ) : null,
            )}
          </svg>
          {h && (
            <Tooltip
              tip={{
                x: `${(sx(h.i) / w) * 100}%`,
                y: 30,
                title: formatX(h.x),
                rows: [
                  {
                    label,
                    value: h.y === null ? 'no builds' : formatY(h.y),
                    color: 'var(--color-chart-1)',
                  },
                ],
              }}
            />
          )}
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars for a ranked list (single series: no legend, values at the tip). */
export function BarList({
  items,
  format = (v) => v.toLocaleString(),
  color = 'var(--color-chart-1)',
}: {
  items: Array<{ label: string; value: number }>;
  format?: (v: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0)
    return <p className="py-6 text-center text-[13px] text-muted">Nothing to show yet.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((i) => (
        <li
          key={i.label}
          className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[12px]"
          title={`${i.label}: ${format(i.value)}`}
        >
          <span className="truncate font-mono text-muted">{i.label}</span>
          <span className="relative h-3">
            <span
              className="absolute inset-y-0 left-0 rounded-r-[4px]"
              style={{ width: `${Math.max(2, (i.value / max) * 100)}%`, background: color }}
            />
          </span>
          <span className="tabular-nums text-fg">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function Legend({
  series,
  onTable,
  table,
}: {
  series: Series[];
  onTable: () => void;
  table: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-4 text-[12px] text-muted">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
      <button
        type="button"
        onClick={onTable}
        className="ml-auto font-mono text-[11px] hover:text-fg hover:underline"
      >
        {table ? 'chart' : 'table'}
      </button>
    </div>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="max-h-64 overflow-auto rounded border border-line">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-raised font-mono text-[11px] text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-1.5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.join('|')} className="border-t border-line">
              {r.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <td key={i} className="px-3 py-1.5 text-fg/90">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

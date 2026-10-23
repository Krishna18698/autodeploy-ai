// The dashboard's loading animations (chosen 2026-10-23), styled in
// globals.css and held still for people who turn motion off:
//   LogoLoader  while the dashboard opens: the logo builds up, live layer last
//   OrbitRing   inside buttons
//   WaveDots    on approve and deploy buttons
//   Skeleton    (panel.tsx) shimmering placeholders in lists and panels

/** The logo building up, oldest deploy first and the live one last. */
export function LogoLoader({ size = 56, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <svg
      viewBox="4 3 24 26"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className="ld-layers shrink-0"
      shapeRendering="geometricPrecision"
    >
      <polygon className="ld-l1" points="16,4 27,9.5 16,15 5,9.5" fill="#4cc38a" />
      <polygon
        className="ld-l2"
        points="5,13.5 16,19 27,13.5 27,16.5 16,22 5,16.5"
        fill="#698bda"
      />
      <polygon
        className="ld-l3"
        points="5,19.5 16,25 27,19.5 27,22.5 16,28 5,22.5"
        fill="#3b4e78"
      />
    </svg>
  );
}

/** A ring with an arc going round, in the button's text colour. */
export function OrbitRing({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden className="ld-orbit shrink-0">
      <circle
        cx="24"
        cy="24"
        r="18"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="6"
      />
      <circle
        cx="24"
        cy="24"
        r="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray="30 120"
      />
    </svg>
  );
}

/** Three dots in the logo's colours rising in turn; darker shades on a light button. */
export function WaveDots({ onLight = false, size = 4 }: { onLight?: boolean; size?: number }) {
  const colors = onLight ? ['#2f8a5e', '#4a68b3', '#3b4e78'] : ['#4cc38a', '#698bda', '#7aa2ff'];
  return (
    <span
      aria-hidden
      className="ld-dots inline-flex shrink-0 items-center"
      style={{ gap: Math.max(3, size * 0.75) }}
    >
      {colors.map((c) => (
        <span
          key={c}
          className="block rounded-full"
          style={{ background: c, width: size, height: size }}
        />
      ))}
    </span>
  );
}

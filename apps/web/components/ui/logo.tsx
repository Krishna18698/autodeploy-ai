// The AutoDeploy mark: the deploy history as layers, the live deploy on top
// (green) and earlier ones fading below (blue). Bare on the site, cropped to
// fill its box; the tab icon (app/icon.svg) is the same drawing, and the
// home-screen icon (app/apple-icon.png) puts it on a dark square.
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      viewBox="3 3 26 26"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0"
      strokeWidth="1"
      strokeLinejoin="round"
    >
      <polygon points="16,4 27,9.5 16,15 5,9.5" fill="#4cc38a" stroke="#4cc38a" />
      <polygon
        points="5,13.5 16,19 27,13.5 27,16.5 16,22 5,16.5"
        fill="#7aa2ff"
        stroke="#7aa2ff"
        opacity="0.85"
      />
      <polygon
        points="5,19.5 16,25 27,19.5 27,22.5 16,28 5,22.5"
        fill="#7aa2ff"
        stroke="#7aa2ff"
        opacity="0.45"
      />
    </svg>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight">
      <LogoMark size={size} />
      AutoDeploy
    </span>
  );
}

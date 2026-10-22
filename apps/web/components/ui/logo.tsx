// The AutoDeploy mark: the deploy history as layers, the live deploy on top
// (green) and earlier ones fading below (blue). The same drawing is the tab
// icon (app/icon.svg) and the home-screen icon (app/apple-icon.png).
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="9" fill="#111318" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="#262a33" />
      <g
        transform="translate(16 16) scale(0.62) translate(-16 -16)"
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
      </g>
    </svg>
  );
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
      <LogoMark size={size} />
      AutoDeploy
    </span>
  );
}

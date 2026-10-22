// The AutoDeploy mark: the deploy history as layers, the live deploy on top
// (green) and earlier ones darker below (blue). Solid fills and no outline keep
// its edges sharp at small sizes. Bare on the site, cropped to fill its box;
// the tab icon (app/icon.svg) is the same drawing, and the home-screen icon
// (app/apple-icon.png) puts it on a dark square.
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      viewBox="4 3 24 26"
      width={size}
      height={size}
      aria-hidden
      className="shrink-0"
      shapeRendering="geometricPrecision"
    >
      <polygon points="16,4 27,9.5 16,15 5,9.5" fill="#4cc38a" />
      <polygon points="5,13.5 16,19 27,13.5 27,16.5 16,22 5,16.5" fill="#698bda" />
      <polygon points="5,19.5 16,25 27,19.5 27,22.5 16,28 5,22.5" fill="#3b4e78" />
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

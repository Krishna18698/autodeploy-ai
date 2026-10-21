// The AutoDeploy mark and wordmark, the same everywhere.
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      className="grid shrink-0 place-items-center rounded-[6px] bg-gradient-to-b from-white to-[#b9c8ff] text-bg shadow-[0_0_0_1px_rgb(255_255_255/0.12),0_4px_12px_-4px_rgb(122_162_255/0.6)]"
    >
      ◆
    </span>
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

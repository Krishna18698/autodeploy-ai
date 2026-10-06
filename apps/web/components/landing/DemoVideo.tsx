'use client';

import { useRef, useState } from 'react';

// The "watch a self-heal" recording (tests/demo/record-self-heal.ts). The video
// only loads once the dialog opens, so it costs the landing page nothing.
export function DemoVideo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);

  const show = () => {
    setOpen(true);
    dialog.current?.showModal();
    requestAnimationFrame(() => void video.current?.play().catch(() => {}));
  };
  const close = () => {
    video.current?.pause();
    dialog.current?.close();
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="flex items-center gap-2 rounded-full border border-line bg-panel/50 px-4 py-2.5 text-sm text-fg/90 transition-colors hover:border-muted"
      >
        <span aria-hidden className="text-[10px]">
          ▶
        </span>{' '}
        Watch a self-heal, 38s
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes on the backdrop; Escape already closes a native <dialog> */}
      <dialog
        ref={dialog}
        aria-label="A failing build repaired and shipped"
        onClose={() => video.current?.pause()}
        onClick={(e) => e.target === dialog.current && close()}
        className="m-auto w-[min(1100px,calc(100vw-32px))] rounded-[10px] border border-line bg-panel p-0 text-fg backdrop:bg-black/70 backdrop:backdrop-blur-sm"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <p className="font-mono text-[12px] text-muted">
            TS2322 → AI patch → rebuilt &amp; validated → approved → live
          </p>
          <button
            type="button"
            onClick={close}
            className="rounded px-2 py-1 text-sm text-muted hover:text-fg"
            aria-label="Close video"
          >
            ✕
          </button>
        </div>
        {open && (
          <video
            ref={video}
            src="/demo/self-heal.mp4"
            poster="/demo/self-heal.jpg"
            controls
            muted
            playsInline
            preload="metadata"
            className="block aspect-[1280/760] w-full bg-bg"
          />
        )}
        <p className="px-4 py-2 font-mono text-[11px] text-muted">
          Recorded on the local stack; the AI step uses the deterministic mock provider.
        </p>
      </dialog>
    </>
  );
}

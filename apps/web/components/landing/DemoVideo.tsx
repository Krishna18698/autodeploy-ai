'use client';

import { useRef, useState } from 'react';
import { DEMO_VERSION } from './demo-version';

// The "watch a self-heal" recording (tests/demo/record-self-heal.ts, cut by
// tests/demo/edit.mjs): a real heal on the live product. The video
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
        className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-5 text-[14px] text-fg transition-colors hover:bg-white/7"
      >
        <span aria-hidden className="text-[10px]">
          ▶
        </span>{' '}
        Watch a self-heal, 31s
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
          <p className="text-[13px] text-muted">Build fails → AI fixes it → you approve → live</p>
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
            src={`/demo/self-heal.mp4?v=${DEMO_VERSION}`}
            poster={`/demo/self-heal.jpg?v=${DEMO_VERSION}`}
            controls
            muted
            playsInline
            preload="metadata"
            className="block aspect-[1280/760] w-full bg-bg"
          />
        )}
        <p className="px-4 py-2 text-[12px] text-muted">
          A real run on AutoDeploy. Waiting is sped up.
        </p>
      </dialog>
    </>
  );
}

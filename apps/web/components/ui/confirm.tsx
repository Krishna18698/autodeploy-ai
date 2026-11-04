'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './button';

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  variant = 'primary',
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: 'primary' | 'danger' | 'ai';
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  // Something that can't be undone starts on Cancel, so Enter doesn't confirm it.
  const destructive = variant === 'danger';
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // After showModal (autoFocus would run while the dialog is still hidden).
      (destructive ? cancelRef : confirmRef).current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, destructive]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="m-auto w-[min(92vw,440px)] rounded-[10px] border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="p-5">
        <h2 id={`${id}-title`} className="text-[15px] font-semibold">
          {title}
        </h2>
        <div id={`${id}-body`} className="mt-2 text-[13px] leading-relaxed text-muted">
          {body}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose} ref={cancelRef}>
          Cancel
        </Button>
        <Button variant={variant} loading={loading} onClick={onConfirm} ref={confirmRef}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

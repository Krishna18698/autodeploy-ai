'use client';

import { AnimatePresence, motion } from 'motion/react';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

type Toast = { id: number; message: string; tone: 'ok' | 'fail' | 'info' };
const Ctx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,360px)] flex-col gap-2"
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              className={`pointer-events-auto rounded-md border px-3.5 py-2.5 text-[13px] shadow-xl backdrop-blur ${
                t.tone === 'ok'
                  ? 'border-ok/40 bg-panel/95 text-fg'
                  : t.tone === 'fail'
                    ? 'border-fail/40 bg-panel/95 text-fg'
                    : 'border-line bg-panel/95 text-fg'
              }`}
            >
              <span
                className={`mr-2 font-mono ${t.tone === 'ok' ? 'text-ok' : t.tone === 'fail' ? 'text-fail' : 'text-run'}`}
              >
                {t.tone === 'ok' ? '✓' : t.tone === 'fail' ? '✗' : '•'}
              </span>
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

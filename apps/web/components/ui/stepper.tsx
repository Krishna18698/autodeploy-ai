'use client';

import type { Deployment } from '@autodeploy/contracts';
import { motion } from 'motion/react';
import { STAGES, stageIndex } from '@/lib/status';

export function Stepper({ status }: { status: Deployment['status'] }) {
  const { index, failed } = stageIndex(status);
  const done =
    status === 'ACTIVE' ||
    status === 'READY' ||
    status === 'SUPERSEDED' ||
    status === 'ROLLED_BACK';
  return (
    <ol
      className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px] sm:gap-x-2"
      aria-label="Pipeline progress"
    >
      {STAGES.map((s, i) => {
        const state =
          i < index || done ? 'done' : i === index ? (failed ? 'failed' : 'current') : 'todo';
        const color = {
          done: 'text-ok',
          current: 'text-run',
          failed: 'text-fail',
          todo: 'text-muted/60',
        }[state];
        const glyph = { done: '✓', current: '●', failed: '✗', todo: '○' }[state];
        return (
          <li
            key={s}
            className="flex items-center gap-2"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <motion.span
              key={state}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              className={`${color} ${state === 'current' ? 'animate-pulse' : ''}`}
            >
              {glyph}
            </motion.span>
            <span className={state === 'todo' ? 'text-muted/60' : 'text-fg'}>{s}</span>
            {i < STAGES.length - 1 && (
              <span
                aria-hidden
                className="relative mx-1 hidden h-px w-6 overflow-hidden bg-line sm:block sm:w-10"
              >
                <motion.span
                  className="absolute inset-y-0 left-0 bg-ok/70"
                  initial={false}
                  animate={{ width: i < index || done ? '100%' : '0%' }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

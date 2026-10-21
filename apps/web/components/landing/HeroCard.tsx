'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

type Stage = { id: string; label: string; sub: string };
type Tone = 'idle' | 'run' | 'ok' | 'fail' | 'warn';

const STAGES: Stage[] = [
  { id: 'analyze', label: 'Analyze', sub: 'vite · pnpm · node 22' },
  { id: 'build', label: 'Build', sub: 'pnpm build' },
  { id: 'recover', label: 'Recover', sub: 'rule R-004 · node engine' },
  { id: 'validate', label: 'Validate', sub: 'chromium · 0 errors' },
  { id: 'live', label: 'Live', sub: 'shop.autodeploy.fyi' },
];

// One loop of the story: build fails, a rule repairs it, it rebuilds and goes live.
const SCRIPT: Record<string, Tone>[] = [
  { analyze: 'run' },
  { analyze: 'ok', build: 'run' },
  { analyze: 'ok', build: 'fail' },
  { analyze: 'ok', build: 'fail', recover: 'warn' },
  { analyze: 'ok', build: 'run', recover: 'ok' },
  { analyze: 'ok', build: 'ok', recover: 'ok', validate: 'run' },
  { analyze: 'ok', build: 'ok', recover: 'ok', validate: 'ok', live: 'ok' },
  { analyze: 'ok', build: 'ok', recover: 'ok', validate: 'ok', live: 'ok' },
];

const TONE: Record<Tone, { dot: string; text: string; ring: string; word: string }> = {
  idle: { dot: 'bg-white/15', text: 'text-muted', ring: 'border-white/7', word: 'queued' },
  run: { dot: 'bg-run text-run', text: 'text-run', ring: 'border-run/50', word: 'running' },
  ok: { dot: 'bg-ok', text: 'text-ok', ring: 'border-ok/40', word: 'passed' },
  fail: { dot: 'bg-fail', text: 'text-fail', ring: 'border-fail/50', word: 'failed' },
  warn: { dot: 'bg-warn text-warn', text: 'text-warn', ring: 'border-warn/50', word: 'recovering' },
};

const FEED = [
  ['shop', 'auto-fixed', 'ok', '41s'],
  ['docs', 'ai patch · approval', 'ai', '1m'],
  ['blog', 'live', 'ok', '38s'],
  ['admin', 'build failed · escalated', 'fail', '2m'],
  ['landing', 'preview pr-42', 'run', '29s'],
  ['api-docs', 'live', 'ok', '33s'],
] as const;

const feedRow = (id: number) => FEED[id % FEED.length] ?? FEED[0];

const FEED_TONE = { ok: 'bg-ok', ai: 'bg-ai', fail: 'bg-fail', run: 'bg-run' } as const;

export function HeroCard() {
  // Reduced motion is only known in the browser, so the first render is the
  // same for everyone (no hydration mismatch) and the effect jumps to the end.
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  // Newest first; ids are monotonic so exactly one row enters and one leaves per tick.
  const [feed, setFeed] = useState(() => [3, 2, 1, 0].map((id) => ({ id, row: feedRow(id) })));

  useEffect(() => {
    if (reduced) {
      setStep(SCRIPT.length - 1);
      return;
    }
    const a = setInterval(() => setStep((s) => (s + 1) % SCRIPT.length), 1150);
    const b = setInterval(
      () =>
        setFeed((rows) => {
          const id = (rows[0]?.id ?? 0) + 1;
          return [{ id, row: feedRow(id) }, ...rows].slice(0, 4);
        }),
      2300,
    );
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [reduced]);

  const state = SCRIPT[step] ?? {};

  return (
    <div className="relative">
      {/* Soft light behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgb(122_162_255/0.18),transparent)] blur-2xl"
      />
      <div className="glass relative w-full max-w-[540px] rounded-2xl bg-panel/80 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center justify-between gap-4 font-mono text-[11px] text-muted">
          <span className="truncate">
            acme/shop <span className="text-fg/60">▸</span> main @ 9f3c2a1
          </span>
          <span className="shrink-0">5 stages · 1 recovery</span>
        </div>

        <ol className="mt-5 grid gap-2.5">
          {STAGES.map((s, i) => {
            const tone: Tone = state[s.id] ?? 'idle';
            const t = TONE[tone];
            return (
              <li key={s.id} className="relative flex items-center gap-3">
                {i < STAGES.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[11px] top-7 h-[calc(100%-6px)] w-px bg-line"
                  >
                    <motion.span
                      className="absolute inset-x-0 top-0 block bg-ok/70"
                      animate={{ height: tone === 'ok' ? '100%' : '0%' }}
                      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </span>
                )}
                <span
                  className={`relative grid size-6 place-items-center rounded-full border ${t.ring} bg-bg/60 transition-colors duration-500`}
                >
                  <span
                    className={`size-2 rounded-full ${t.dot} transition-colors duration-500 ${tone === 'run' || tone === 'warn' ? 'animate-[pulse-dot_1.4s_ease-in-out_infinite]' : ''}`}
                  />
                </span>
                <div
                  className={`flex flex-1 items-center justify-between rounded-lg border ${t.ring} bg-white/[0.025] px-3 py-2 transition-colors duration-500`}
                >
                  <div>
                    <div className="text-[13px] font-medium">{s.label}</div>
                    <div className="font-mono text-[10.5px] text-muted">{s.sub}</div>
                  </div>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={tone}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.25 }}
                      className={`font-mono text-[10.5px] ${t.text}`}
                    >
                      {t.word}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-5 border-t border-white/6 pt-3">
          <div className="mb-2 text-[11px] text-muted">Recent deploys</div>
          <ul className="relative h-[92px] overflow-hidden font-mono text-[11px]">
            <AnimatePresence initial={false} mode="popLayout">
              {feed.map(({ id, row: [name, what, tone, dur] }, i) => (
                <motion.li
                  key={id}
                  layout
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1 - i * 0.18, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="flex h-[23px] items-center gap-2"
                >
                  <span className={`size-1.5 rounded-full ${FEED_TONE[tone]}`} />
                  <span className="w-16 text-fg/90">{name}</span>
                  <span className="flex-1 truncate text-muted">{what}</span>
                  <span className="text-muted">{dur}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </div>
    </div>
  );
}

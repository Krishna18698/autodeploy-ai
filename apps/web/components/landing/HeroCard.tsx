'use client';

import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react';
import { useEffect, useState } from 'react';

type Stage = { id: string; label: string; sub: string };
type Tone = 'idle' | 'run' | 'ok' | 'fail' | 'warn';

const STAGES: Stage[] = [
  { id: 'analyze', label: 'Analyze', sub: 'vite · pnpm · node 22' },
  { id: 'build', label: 'Build', sub: 'pnpm build' },
  { id: 'recover', label: 'Recover', sub: 'rule R-004 · node engine' },
  { id: 'validate', label: 'Validate', sub: 'chromium · 0 errors' },
  { id: 'live', label: 'Live', sub: 'shop.autodeploy.eu.org' },
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
  idle: { dot: 'bg-line', text: 'text-muted', ring: 'border-line', word: 'queued' },
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
  const reduced = useReducedMotion();
  const [step, setStep] = useState(reduced ? SCRIPT.length - 1 : 0);
  // Newest first; ids are monotonic so exactly one row enters and one leaves per tick.
  const [feed, setFeed] = useState(() => [3, 2, 1, 0].map((id) => ({ id, row: feedRow(id) })));

  useEffect(() => {
    if (reduced) return;
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

  // Pointer-driven tilt with spring smoothing; touch devices drift on their own.
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 60, damping: 18, mass: 0.6 });
  const sy = useSpring(py, { stiffness: 60, damping: 18, mass: 0.6 });
  const rotateY = useTransform(sx, [-1, 1], [-20, -4]);
  const rotateX = useTransform(sy, [-1, 1], [9, -3]);

  useEffect(() => {
    if (reduced) return;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) {
      let raf = 0;
      const t0 = performance.now();
      const loop = (now: number) => {
        const t = (now - t0) / 1000;
        px.set(Math.sin(t * 0.5) * 0.6);
        py.set(Math.cos(t * 0.37) * 0.5);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    const onMove = (e: PointerEvent) => {
      px.set((e.clientX / window.innerWidth) * 2 - 1);
      py.set((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reduced, px, py]);

  const state = SCRIPT[step] ?? {};

  return (
    <div className="relative [perspective:1400px]">
      <motion.div
        style={reduced ? { rotateY: -12, rotateX: 4 } : { rotateY, rotateX }}
        className="glass relative w-full max-w-[560px] rounded-[10px] p-5 shadow-[0_40px_120px_-20px_rgba(0,0,0,0.8)] [transform-style:preserve-3d]"
      >
        {/* edge light */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[10px] [background:linear-gradient(120deg,rgba(34,211,238,0.35),transparent_30%,transparent_70%,rgba(52,211,153,0.25))] [mask:linear-gradient(#000,#000)_content-box,linear-gradient(#000,#000)] [mask-composite:exclude] p-px"
        />

        <div className="flex items-center justify-between gap-4 font-mono text-[11px] text-muted [transform:translateZ(20px)]">
          <span className="truncate">
            acme/shop <span className="text-fg/60">▸</span> main @ 9f3c2a1
          </span>
          <span className="shrink-0">5 stages · 1 recovery</span>
        </div>

        <ol className="mt-5 grid gap-2.5 [transform:translateZ(46px)]">
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
                  className={`flex flex-1 items-center justify-between rounded-md border ${t.ring} bg-raised/70 px-3 py-2 transition-colors duration-500`}
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

        <div className="mt-5 border-t border-line pt-3 [transform:translateZ(28px)]">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            recent deploys
          </div>
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
      </motion.div>
    </div>
  );
}

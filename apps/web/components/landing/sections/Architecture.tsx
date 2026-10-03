'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef } from 'react';
import { whenIdle } from '@/lib/idle';

gsap.registerPlugin(useGSAP, ScrollTrigger);

type Node = { id: string; x: number; y: number; label: string; sub: string; tone?: 'ai' | 'run' };
const NODES: Node[] = [
  { id: 'gh', x: 70, y: 70, label: 'GitHub', sub: 'push · PR webhooks' },
  { id: 'api', x: 270, y: 70, label: 'API', sub: 'Fastify · RLS · idempotency' },
  { id: 'pg', x: 470, y: 70, label: 'Postgres', sub: 'queue · outbox · state' },
  { id: 'worker', x: 470, y: 210, label: 'Worker', sub: 'leases · recovery', tone: 'run' },
  { id: 'sandbox', x: 270, y: 210, label: 'Sandbox', sub: 'gVisor · egress allowlist' },
  { id: 'ai', x: 670, y: 210, label: 'AI gateway', sub: 'rules first · breakers', tone: 'ai' },
  { id: 'kafka', x: 670, y: 70, label: 'Kafka', sub: 'events · replay' },
  { id: 'edge', x: 70, y: 210, label: 'Edge', sub: 'Worker · KV · B2' },
];
const EDGES: Array<[string, string]> = [
  ['gh', 'api'],
  ['api', 'pg'],
  ['pg', 'worker'],
  ['worker', 'sandbox'],
  ['worker', 'ai'],
  ['pg', 'kafka'],
  ['sandbox', 'edge'],
];
const FALLBACK: Node = { id: '?', x: 0, y: 0, label: '', sub: '' };
const pos = (id: string): Node => NODES.find((n) => n.id === id) ?? FALLBACK;

export function Architecture() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    (_ctx, contextSafe) => {
      // Below the fold: set up after first paint.
      return whenIdle(
        contextSafe?.(() => {
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          gsap.from('[data-node]', {
            opacity: 0,
            scale: 0.9,
            transformOrigin: 'center',
            stagger: 0.08,
            duration: 0.6,
            ease: 'expo.out',
            scrollTrigger: { trigger: root.current, start: 'top 70%' },
          });
          gsap.from('[data-edge]', {
            strokeDashoffset: 300,
            stagger: 0.1,
            duration: 0.9,
            ease: 'power2.out',
            scrollTrigger: { trigger: root.current, start: 'top 65%' },
          });
        }) ?? (() => {}),
      );
    },
    { scope: root },
  );
  return (
    <section ref={root} id="architecture" className="mx-auto max-w-7xl px-4 py-28 sm:px-6">
      <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-run">05 · system</p>
      <h2 className="mt-3 text-[clamp(2rem,4.4vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
        How it <span className="font-serif font-normal italic">works.</span>
      </h2>
      <p className="mt-4 max-w-2xl text-[15px] text-muted">
        Jobs live in Postgres, where leases and retries belong. Events fan out through Kafka to
        independent consumers. Sites are served from the edge. Runs on ₹0 of free tiers.
      </p>
      <div className="glass mt-12 overflow-x-auto rounded-[12px] p-4">
        <svg
          viewBox="0 0 740 280"
          className="h-auto w-full min-w-[640px]"
          role="img"
          aria-label="Architecture: GitHub to API to Postgres; the worker claims jobs, builds in the sandbox, asks the AI gateway when rules fail, and publishes to the edge; Postgres relays events to Kafka."
        >
          <defs>
            <linearGradient id="edge-grad" x1="0" x2="1">
              <stop offset="0" stopColor="#22d3ee" stopOpacity="0.15" />
              <stop offset="1" stopColor="#34d399" stopOpacity="0.7" />
            </linearGradient>
          </defs>
          {EDGES.map(([a, b]) => {
            const p = pos(a);
            const q = pos(b);
            const d = `M${p.x},${p.y} L${q.x},${q.y}`;
            return (
              <g key={`${a}-${b}`}>
                <path
                  data-edge
                  d={d}
                  stroke="url(#edge-grad)"
                  strokeWidth="1.5"
                  fill="none"
                  strokeDasharray="300"
                  strokeDashoffset="0"
                />
                <circle r="3" fill="#22d3ee" className="motion-reduce:hidden">
                  <animateMotion
                    dur={`${2.4 + (a.length % 3) * 0.6}s`}
                    repeatCount="indefinite"
                    path={d}
                  />
                </circle>
              </g>
            );
          })}
          {NODES.map((n) => (
            <g key={n.id} data-node transform={`translate(${n.x - 78} ${n.y - 28})`}>
              <rect
                width="156"
                height="56"
                rx="8"
                fill="#12151a"
                stroke={n.tone === 'ai' ? '#a78bfa' : n.tone === 'run' ? '#22d3ee' : '#252a33'}
                strokeOpacity={n.tone ? 0.6 : 1}
              />
              <text x="14" y="24" className="fill-fg text-[13px] font-medium">
                {n.label}
              </text>
              <text x="14" y="42" className="fill-muted font-mono text-[10px]">
                {n.sub}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

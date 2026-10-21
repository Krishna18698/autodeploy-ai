import { FadeIn, SectionHead } from '../FadeIn';

type Node = { id: string; x: number; y: number; label: string; sub: string; tone?: 'ai' | 'run' };
// Four columns of cards, all inside the viewBox with a margin; a card is wide
// enough for its longest caption ("Fastify · RLS · idempotency" ≈ 157 units).
const VIEW = { w: 880, h: 260 };
const CARD = { w: 184, h: 64 };
const COL = [110, 330, 550, 770] as const;
const ROW = [60, 200] as const;
const NODES: Node[] = [
  { id: 'gh', x: COL[0], y: ROW[0], label: 'GitHub', sub: 'push · PR webhooks' },
  { id: 'api', x: COL[1], y: ROW[0], label: 'API', sub: 'Fastify · RLS · idempotency' },
  { id: 'pg', x: COL[2], y: ROW[0], label: 'Postgres', sub: 'queue · outbox · state' },
  { id: 'kafka', x: COL[3], y: ROW[0], label: 'Kafka', sub: 'events · replay' },
  { id: 'edge', x: COL[0], y: ROW[1], label: 'Edge', sub: 'Worker · KV · B2' },
  { id: 'sandbox', x: COL[1], y: ROW[1], label: 'Sandbox', sub: 'gVisor · egress allowlist' },
  { id: 'worker', x: COL[2], y: ROW[1], label: 'Worker', sub: 'leases · recovery', tone: 'run' },
  {
    id: 'ai',
    x: COL[3],
    y: ROW[1],
    label: 'AI gateway',
    sub: 'rules first · breakers',
    tone: 'ai',
  },
];
// The same flow as steps, for screens too narrow for the diagram.
const STEPS: Array<[string, string]> = [
  ['GitHub', 'A push or pull request arrives as a webhook.'],
  ['API', 'Fastify checks it and records the deployment and its job in one transaction.'],
  ['Postgres', 'Holds the job queue and every state change; events fan out to Kafka.'],
  ['Worker', 'Claims the job under a lease and builds in a gVisor sandbox.'],
  ['AI gateway', 'When rules can’t fix a failure, proposes a patch for a person to approve.'],
  ['Edge', 'Serves the result from Cloudflare: files from B2, server apps on demand.'],
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
  return (
    <section id="architecture" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <SectionHead
        eyebrow="Under the hood"
        title="Built like a real platform."
        sub="Jobs live in Postgres, where leases and retries belong. Events fan out through Kafka to independent consumers. Static files are served from the edge; server-rendered apps wake on demand in sandboxed containers."
      />
      <ol className="mt-10 flex flex-col gap-3 md:hidden">
        {STEPS.map(([name, what], i) => (
          <li key={name} className="glass flex gap-3 rounded-2xl p-4">
            <span className="font-mono text-[12px] text-run">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <span className="block text-[15px] font-medium text-fg">{name}</span>
              <span className="mt-0.5 block text-[14px] leading-6 text-muted">{what}</span>
            </span>
          </li>
        ))}
      </ol>
      <FadeIn className="mt-12 hidden md:block">
        <div className="glass rounded-2xl p-4 lg:p-6">
          <svg
            viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
            className="h-auto w-full"
            role="img"
            aria-label="Architecture: GitHub to API to Postgres; the worker claims jobs, builds in the sandbox, asks the AI gateway when rules fail, and publishes to the edge; Postgres relays events to Kafka."
          >
            <defs>
              <linearGradient
                id="edge-grad"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1="0"
                x2={VIEW.w}
                y2="0"
              >
                <stop offset="0" stopColor="#7aa2ff" stopOpacity="0.25" />
                <stop offset="1" stopColor="#7aa2ff" stopOpacity="0.6" />
              </linearGradient>
            </defs>
            {EDGES.map(([a, b]) => {
              const p = pos(a);
              const q = pos(b);
              const d = `M${p.x},${p.y} L${q.x},${q.y}`;
              return (
                <g key={`${a}-${b}`}>
                  <path d={d} stroke="url(#edge-grad)" strokeWidth="1.5" fill="none" />
                  <circle r="3" fill="#7aa2ff" className="motion-reduce:hidden">
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
              <g key={n.id} transform={`translate(${n.x - CARD.w / 2} ${n.y - CARD.h / 2})`}>
                <rect
                  width={CARD.w}
                  height={CARD.h}
                  rx="8"
                  fill="#111214"
                  stroke={n.tone === 'ai' ? '#c084fc' : n.tone === 'run' ? '#7aa2ff' : '#26272b'}
                  strokeOpacity={n.tone ? 0.6 : 1}
                />
                <text x="14" y="27" className="fill-fg text-[14px] font-medium">
                  {n.label}
                </text>
                <text x="14" y="47" className="fill-muted font-mono text-[10px]">
                  {n.sub}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </FadeIn>
    </section>
  );
}

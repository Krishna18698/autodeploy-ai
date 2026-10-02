import type { Deployment } from '@autodeploy/contracts';
import { STATUS, TONE_CLASS, type Tone } from '@/lib/status';

export function Dot({
  tone,
  pulse = false,
  className = '',
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  const t = TONE_CLASS[tone];
  return (
    <span
      aria-hidden
      className={`inline-block size-1.5 shrink-0 rounded-full ${t.dot} ${pulse ? `${t.text} animate-[pulse-dot_1.6s_ease-in-out_infinite]` : ''} ${className}`}
    />
  );
}

export function StatusPill({
  status,
  size = 'sm',
}: {
  status: Deployment['status'];
  size?: 'sm' | 'md';
}) {
  const s = STATUS[status];
  const t = TONE_CLASS[s.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border ${t.border} ${t.bg} ${t.text} font-mono ${size === 'md' ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-0.5 text-[11px]'} transition-colors duration-300`}
    >
      <Dot tone={s.tone} pulse={Boolean(s.live)} />
      {s.label}
    </span>
  );
}

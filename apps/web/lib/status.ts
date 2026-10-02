import type { Deployment } from '@autodeploy/contracts';

export type Tone = 'run' | 'ok' | 'warn' | 'fail' | 'ai' | 'idle';

// Status → tone + human label. Colour is never the only signal: every
// status renders with its label (and a pulse while work is in flight).
export const STATUS: Record<Deployment['status'], { tone: Tone; label: string; live?: boolean }> = {
  CREATED: { tone: 'idle', label: 'Created', live: true },
  ANALYZING: { tone: 'run', label: 'Analyzing', live: true },
  QUEUED: { tone: 'idle', label: 'Queued', live: true },
  BUILDING: { tone: 'run', label: 'Building', live: true },
  BUILD_FAILED: { tone: 'fail', label: 'Build failed', live: true },
  RECOVERING: { tone: 'warn', label: 'Recovering', live: true },
  VALIDATING: { tone: 'run', label: 'Validating', live: true },
  AWAITING_APPROVAL: { tone: 'ai', label: 'Awaiting approval' },
  NEEDS_INPUT: { tone: 'warn', label: 'Needs input' },
  READY: { tone: 'ok', label: 'Ready' },
  ACTIVE: { tone: 'ok', label: 'Live' },
  SUPERSEDED: { tone: 'idle', label: 'Superseded' },
  ROLLED_BACK: { tone: 'idle', label: 'Rolled back' },
  FAILED: { tone: 'fail', label: 'Failed' },
  CANCELED: { tone: 'idle', label: 'Canceled' },
};

export const TONE_CLASS: Record<Tone, { dot: string; text: string; border: string; bg: string }> = {
  run: { dot: 'bg-run', text: 'text-run', border: 'border-run/40', bg: 'bg-run/10' },
  ok: { dot: 'bg-ok', text: 'text-ok', border: 'border-ok/40', bg: 'bg-ok/10' },
  warn: { dot: 'bg-warn', text: 'text-warn', border: 'border-warn/40', bg: 'bg-warn/10' },
  fail: { dot: 'bg-fail', text: 'text-fail', border: 'border-fail/40', bg: 'bg-fail/10' },
  ai: { dot: 'bg-ai', text: 'text-ai', border: 'border-ai/40', bg: 'bg-ai/10' },
  idle: { dot: 'bg-muted/60', text: 'text-muted', border: 'border-line', bg: 'bg-raised' },
};

/** Where a deployment is in the pipeline, for the stepper. */
export const STAGES = ['Analyze', 'Queue', 'Build', 'Validate', 'Live'] as const;

export function stageIndex(status: Deployment['status']): { index: number; failed: boolean } {
  switch (status) {
    case 'CREATED':
    case 'ANALYZING':
      return { index: 0, failed: false };
    case 'QUEUED':
      return { index: 1, failed: false };
    case 'BUILDING':
      return { index: 2, failed: false };
    case 'BUILD_FAILED':
    case 'RECOVERING':
      return { index: 2, failed: true };
    case 'VALIDATING':
      return { index: 3, failed: false };
    case 'AWAITING_APPROVAL':
    case 'NEEDS_INPUT':
      return { index: 3, failed: false };
    case 'FAILED':
      return { index: 2, failed: true };
    case 'CANCELED':
      return { index: 1, failed: true };
    default:
      return { index: 4, failed: false };
  }
}

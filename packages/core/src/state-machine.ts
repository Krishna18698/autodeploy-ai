// Deployment lifecycle. The same table is synced into Postgres
// (deployment_transition_rules) and enforced by a trigger, so an illegal
// transition fails even if application code is wrong.

export const DEPLOYMENT_STATUSES = [
  'CREATED',
  'ANALYZING',
  'QUEUED',
  'BUILDING',
  'BUILD_FAILED',
  'RECOVERING',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'NEEDS_INPUT',
  'READY',
  'ACTIVE',
  'SUPERSEDED',
  'ROLLED_BACK',
  'FAILED',
  'CANCELED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  CREATED: ['ANALYZING', 'FAILED', 'CANCELED'],
  ANALYZING: ['QUEUED', 'NEEDS_INPUT', 'FAILED', 'CANCELED'],
  QUEUED: ['BUILDING', 'FAILED', 'CANCELED'],
  BUILDING: ['VALIDATING', 'BUILD_FAILED', 'FAILED', 'CANCELED'],
  BUILD_FAILED: ['RECOVERING', 'NEEDS_INPUT', 'FAILED'],
  // Recovery either re-queues a patched build, or gives up / asks a human.
  RECOVERING: ['QUEUED', 'NEEDS_INPUT', 'FAILED', 'CANCELED'],
  // Validation can send a build back into recovery (e.g. wrong base path).
  VALIDATING: ['READY', 'AWAITING_APPROVAL', 'BUILD_FAILED', 'FAILED', 'CANCELED'],
  // AI-patched builds are already validated; approval publishes them as-is.
  AWAITING_APPROVAL: ['READY', 'FAILED', 'CANCELED'],
  NEEDS_INPUT: ['FAILED', 'CANCELED'],
  READY: ['ACTIVE', 'SUPERSEDED'],
  ACTIVE: ['SUPERSEDED', 'ROLLED_BACK'],
  SUPERSEDED: ['ACTIVE'],
  ROLLED_BACK: ['ACTIVE'],
  FAILED: [],
  CANCELED: [],
};

export const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(['FAILED', 'CANCELED']);

// Statuses in which work is still in flight; used for cancellation and the UI.
export const IN_PROGRESS: ReadonlySet<DeploymentStatus> = new Set([
  'CREATED',
  'ANALYZING',
  'QUEUED',
  'BUILDING',
  'BUILD_FAILED',
  'RECOVERING',
  'VALIDATING',
]);

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DeploymentStatus,
    readonly to: DeploymentStatus,
  ) {
    super(`illegal deployment transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function transitionPairs(): Array<[DeploymentStatus, DeploymentStatus]> {
  return DEPLOYMENT_STATUSES.flatMap((from) =>
    TRANSITIONS[from].map((to) => [from, to] as [DeploymentStatus, DeploymentStatus]),
  );
}

// Builds in the user's own GitHub Actions (ADR 0010): what the worker, the API
// and the workflow in the user's repository agree on.

/** The workflow file the GitHub App adds to the user's repository. */
export const CI_WORKFLOW_PATH = '.github/workflows/autodeploy.yml';
/** Bumped when the workflow changes; an older one is offered an update. */
export const CI_WORKFLOW_VERSION = 1;
/** The audience of the job's OIDC token: the API it may talk to. */
export const ciAudience = (apiUrl: string) => apiUrl.replace(/\/+$/, '');

/** The built output comes back in parts of at most this many bytes. */
export const CI_PART_MAX_BYTES = 32 * 1024 * 1024;
export const CI_MAX_PARTS = 32; // 1 GiB at most, before the per-build cap below
/** Log lines a build may send, and how long each may be. */
export const CI_MAX_LOG_LINES = 100_000;
export const CI_MAX_LINE_CHARS = 4_000;

/** Valkey keys for one build attempt, shared by the worker and the API. */
export const ciKeys = (attemptId: string) => ({
  /** CiState (JSON), written by the worker before it starts the workflow. */
  state: `ci:${attemptId}`,
  /** The GitHub run that claimed the attempt (first /start wins). */
  run: `ci:${attemptId}:run`,
  log: `ci:${attemptId}:log`,
  logCount: `ci:${attemptId}:log-count`,
  bytes: `ci:${attemptId}:bytes`,
  /** CiDone (JSON), written by the API when the workflow reports the end. */
  done: `ci:${attemptId}:done`,
});
/** Object storage prefix for an attempt's output parts. */
export const ciPartsPrefix = (attemptId: string) => `ci/${attemptId}/`;
export const ciPartKey = (attemptId: string, n: number) =>
  `${ciPartsPrefix(attemptId)}${String(n).padStart(3, '0')}`;

export type CiState = {
  /** One-time secret for this attempt, sent to the workflow in its inputs. */
  nonce: string;
  /** owner/name, lowercase: the only repository whose jobs may report for it. */
  repo: string;
  deploymentId: string;
  projectId: string;
  orgId: string;
  /** Biggest output (compressed) accepted, bytes. */
  maxBytes: number;
};
export type CiDone = { exitCode: number; parts: number; bytes: number };

/**
 * What the workflow is told to do (its single input, JSON). Nothing secret
 * except the nonce, which is useless without a GitHub job token for the
 * project's own repository.
 */
export type CiJob = {
  v: number;
  api: string;
  attemptId: string;
  nonce: string;
  sha: string;
  node: number;
  /** The shell script to run in the checkout (install, then build). */
  script: string;
  /** A repair to apply first (git apply), relative to `root`. */
  patch?: string;
  root: string;
  /** Non-secret build variables; the project's secrets come from /start. */
  env: Record<string, string>;
  /** Which node_modules come back: all of them, those under one path, or none. */
  keep: { deps: 'all' } | { deps: 'under'; path: string } | { deps: 'none' };
  /** Size of each output part, at most CI_PART_MAX_BYTES. */
  partBytes: number;
  /** Shown as the run's name on GitHub. */
  label: string;
};

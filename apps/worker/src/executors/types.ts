import type { BuildConfig } from '@autodeploy/core';
import type { LogSink } from '../pipeline/logs.js';

export type ExecuteInput = {
  attemptId: string;
  /** Workspace with the source already checked out. */
  srcDir: string;
  config: BuildConfig;
  /** Decrypted project env vars; injected into the build, never logged. */
  secrets: Record<string, string>;
  log: LogSink;
  signal: AbortSignal;
};

export type ExecuteResult =
  | { ok: true; outputDir: string; durationMs: number }
  | {
      ok: false;
      exitCode: number | null;
      reason: 'failed' | 'timeout' | 'canceled' | 'output_missing';
      durationMs: number;
      indexDirs: string[];
    };

/** Strategy interface: where and how a build runs. */
export interface Executor {
  readonly name: 'sandbox' | 'github_actions';
  execute(input: ExecuteInput): Promise<ExecuteResult>;
}

import type { Analysis } from './analyzer.js';

// Everything an executor needs to run one build attempt. Rules produce a new
// BuildConfig from an old one; nothing mutates in place, so every attempt's
// config is recorded exactly as it ran.

export type BuildConfig = {
  nodeVersion: number;
  installCommand: string | null;
  buildCommand: string | null;
  outputDir: string;
  rootDir: string;
  /** Non-secret build env (secrets are injected separately and never stored here). */
  env: Record<string, string>;
  /** Unified diff applied to the source before building (AI repairs only). */
  patch?: string;
  /** Publishing this attempt needs a human to approve it. */
  requiresApproval?: boolean;
};

export type ProjectOverrides = Partial<
  Pick<BuildConfig, 'nodeVersion' | 'installCommand' | 'buildCommand' | 'outputDir' | 'rootDir'>
>;

export function buildConfigFrom(analysis: Analysis, overrides: ProjectOverrides = {}): BuildConfig {
  return {
    nodeVersion: overrides.nodeVersion ?? analysis.node.value,
    installCommand: overrides.installCommand ?? analysis.installCommand.value,
    buildCommand: overrides.buildCommand ?? analysis.buildCommand.value,
    outputDir: overrides.outputDir ?? analysis.outputDir.value,
    rootDir: overrides.rootDir ?? analysis.rootDir,
    env: {},
  };
}

export type ConfigChange = {
  field: keyof BuildConfig | `env.${string}`;
  from: unknown;
  to: unknown;
};

export function diffConfig(a: BuildConfig, b: BuildConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const key of [
    'nodeVersion',
    'installCommand',
    'buildCommand',
    'outputDir',
    'rootDir',
  ] as const) {
    if (a[key] !== b[key]) changes.push({ field: key, from: a[key], to: b[key] });
  }
  const envKeys = new Set([...Object.keys(a.env), ...Object.keys(b.env)]);
  for (const k of envKeys) {
    if (a.env[k] !== b.env[k]) changes.push({ field: `env.${k}`, from: a.env[k], to: b.env[k] });
  }
  if ((a.patch ?? '') !== (b.patch ?? ''))
    changes.push({ field: 'patch', from: Boolean(a.patch), to: Boolean(b.patch) });
  return changes;
}

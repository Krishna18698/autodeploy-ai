import { SUPPORTED_NODE_MAJORS } from './analyzer.js';
import type { BuildConfig } from './build-config.js';
import { satisfies } from './semver.js';
import type { ErrorCode, ErrorSignature } from './signatures.js';

// Deterministic, reversible repairs. A rule only ever changes build
// configuration (never source code), and returns a new config.

export type RuleContext = {
  signature: ErrorSignature;
  config: BuildConfig;
  framework: string;
  packageManager: string;
  /** Directories in the workspace that contain an index.html after the build. */
  indexDirs: readonly string[];
};

export type RuleResult = {
  ruleId: string;
  title: string;
  explanation: string;
  config: BuildConfig;
};

export type Rule = {
  id: string;
  codes: readonly ErrorCode[];
  title: string;
  apply(ctx: RuleContext): RuleResult | undefined;
};

const FRAMEWORK_BUILD: Record<string, string> = {
  vite: 'npx --no-install vite build',
  next: 'npx --no-install next build',
  astro: 'npx --no-install astro build',
  cra: 'npx --no-install react-scripts build',
};

export const RULES: readonly Rule[] = [
  {
    id: 'R-001',
    codes: ['NETWORK_TRANSIENT'],
    title: 'Retry after a transient network failure',
    apply: ({ config }) => ({
      ruleId: 'R-001',
      title: 'Retry after a transient network failure',
      explanation:
        'The registry or network failed mid-install. Nothing in the repo is wrong; retrying unchanged.',
      config: { ...config },
    }),
  },
  {
    id: 'R-002',
    codes: ['LOCKFILE_MISMATCH'],
    title: 'Install without a frozen lockfile',
    apply: ({ config, packageManager }) => {
      const install =
        packageManager === 'pnpm'
          ? 'pnpm install --no-frozen-lockfile'
          : packageManager === 'yarn'
            ? 'yarn install --no-immutable'
            : packageManager === 'bun'
              ? 'bun install'
              : 'npm install';
      if (config.installCommand === install) return undefined;
      return {
        ruleId: 'R-002',
        title: 'Install without a frozen lockfile',
        explanation: `The lockfile is out of date with package.json. Installing with "${install}" for this build; commit an updated lockfile to make it reproducible.`,
        config: { ...config, installCommand: install },
      };
    },
  },
  {
    id: 'R-003',
    codes: ['PEER_DEPS'],
    title: 'Relax npm peer dependency resolution',
    apply: ({ config, packageManager }) => {
      if (packageManager !== 'npm' || config.installCommand?.includes('--legacy-peer-deps'))
        return undefined;
      const base = config.installCommand ?? 'npm install';
      return {
        ruleId: 'R-003',
        title: 'Relax npm peer dependency resolution',
        explanation:
          'npm refused conflicting peer dependency ranges. Retrying with --legacy-peer-deps (npm 6 behaviour).',
        config: { ...config, installCommand: `${base} --legacy-peer-deps` },
      };
    },
  },
  {
    id: 'R-004',
    codes: ['NODE_ENGINE'],
    title: 'Switch to a Node version the project supports',
    apply: ({ config, signature }) => {
      const range =
        signature.captures.range ??
        /(>=?\s*\d[\d.]*|\^\d[\d.]*|~\d[\d.]*|\d+\.x)/.exec(signature.keyLine)?.[1] ??
        '';
      const candidates = SUPPORTED_NODE_MAJORS.filter((m) => m !== config.nodeVersion);
      // The closest supported version that satisfies the range: the smallest jump from what the repo had.
      const wanted = range.replace(/\+$/, '');
      let next = wanted
        ? [...candidates]
            .sort((a, b) => a - b)
            .find((m) => satisfies([m, 99, 99], wanted) || satisfies([m, 0, 0], wanted))
        : undefined;
      // No parsable range: step up one supported major.
      if (next === undefined) next = candidates.find((m) => m > config.nodeVersion);
      if (next === undefined) return undefined;
      return {
        ruleId: 'R-004',
        title: 'Switch to a Node version the project supports',
        explanation: `A dependency requires Node ${range || 'a newer version'}; Node ${config.nodeVersion} was used. Rebuilding on Node ${next}.`,
        config: { ...config, nodeVersion: next },
      };
    },
  },
  {
    id: 'R-005',
    codes: ['OUTPUT_DIR_MISSING'],
    title: 'Point at the directory the build actually produced',
    apply: ({ config, indexDirs }) => {
      // A server build has no index.html to find; a missing server is not an output-dir problem.
      if (config.mode === 'ssr') return undefined;
      const preferred = ['dist', 'build', 'out', '.output/public', 'public', '_site'];
      // The repo root holds the *source* index.html when there is a build step; never publish it.
      const candidates = config.buildCommand ? indexDirs.filter((d) => d !== '.') : indexDirs;
      const found = preferred.find((d) => candidates.includes(d)) ?? candidates[0];
      if (!found || found === config.outputDir) return undefined;
      return {
        ruleId: 'R-005',
        title: 'Point at the directory the build actually produced',
        explanation: `The build finished but "${config.outputDir}" has no index.html. "${found}" does, so publishing that.`,
        config: { ...config, outputDir: found },
      };
    },
  },
  {
    id: 'R-006',
    codes: ['OUT_OF_MEMORY'],
    title: 'Raise the Node heap limit',
    apply: ({ config }) => {
      if (config.env.NODE_OPTIONS?.includes('max-old-space-size')) return undefined;
      return {
        ruleId: 'R-006',
        title: 'Raise the Node heap limit',
        explanation:
          'The build ran out of JavaScript heap. Raising the limit to 2.5 GB (the sandbox has 3 GB).',
        config: { ...config, env: { ...config.env, NODE_OPTIONS: '--max-old-space-size=2560' } },
      };
    },
  },
  {
    id: 'R-007',
    codes: ['SCRIPT_MISSING'],
    title: 'Use the framework build command directly',
    apply: ({ config, framework }) => {
      const cmd = FRAMEWORK_BUILD[framework];
      if (!cmd || config.buildCommand === cmd) return undefined;
      return {
        ruleId: 'R-007',
        title: 'Use the framework build command directly',
        explanation: `package.json has no "build" script. Running the ${framework} CLI directly.`,
        config: { ...config, buildCommand: cmd },
      };
    },
  },
];

/** Codes that a human has to resolve; no amount of retrying helps. */
export const NEEDS_HUMAN: ReadonlySet<ErrorCode> = new Set(['MISSING_ENV']);
/** Codes that mean "not supported in V1"; fail with an explanation. */
export const UNSUPPORTED: ReadonlySet<ErrorCode> = new Set(['SSR_REQUIRED']);
/** Codes worth sending to the AI path when no rule applies. */
export const AI_ELIGIBLE: ReadonlySet<ErrorCode> = new Set([
  'TS_COMPILE',
  'MODULE_NOT_FOUND',
  'SYNTAX_ERROR',
  'PEER_DEPS',
  'UNKNOWN',
]);

export type RecoveryDecision =
  | { kind: 'rule'; result: RuleResult }
  | { kind: 'ai' }
  | { kind: 'needs_input'; reason: string }
  | { kind: 'give_up'; reason: string };

export type RecoveryHistory = {
  /** Signatures of every failed attempt so far, oldest first (including the current one). */
  signatures: readonly string[];
  /** Rule ids already applied in this deployment. */
  appliedRules: readonly string[];
  /** Automated repair attempts already made. */
  repairsMade: number;
};

export const MAX_REPAIRS = 2;

export function decideRecovery(
  ctx: RuleContext,
  history: RecoveryHistory,
  aiAvailable: boolean,
): RecoveryDecision {
  const { signature } = ctx;
  if (history.repairsMade >= MAX_REPAIRS) {
    return {
      kind: 'give_up',
      reason: `Repair budget used (${MAX_REPAIRS} attempts). Logs preserved for review.`,
    };
  }
  const seen = history.signatures.slice(0, -1);
  if (seen.includes(signature.signature)) {
    return {
      kind: 'give_up',
      reason: 'The previous repair did not change the failure (same error signature). Stopping.',
    };
  }
  if (NEEDS_HUMAN.has(signature.code)) {
    const name = signature.captures.name;
    return {
      kind: 'needs_input',
      reason: name
        ? `Set the ${name} environment variable and redeploy.`
        : 'A required environment variable is missing.',
    };
  }
  if (UNSUPPORTED.has(signature.code)) {
    return {
      kind: 'give_up',
      reason: 'This app needs a server at runtime; V1 deploys static sites only.',
    };
  }
  for (const rule of RULES) {
    if (!rule.codes.includes(signature.code)) continue;
    // A rule gets one shot per deployment, except plain retries.
    if (rule.id !== 'R-001' && history.appliedRules.includes(rule.id)) continue;
    const result = rule.apply(ctx);
    if (result) return { kind: 'rule', result };
  }
  if (signature.code === 'PLATFORM') {
    return {
      kind: 'give_up',
      reason:
        'The build infrastructure is missing a component (no build image for this Node version). The operators have been alerted; nothing in your repository is wrong.',
    };
  }
  if (signature.code === 'TIMEOUT') {
    return { kind: 'give_up', reason: 'The build exceeded the time limit.' };
  }
  if (aiAvailable && AI_ELIGIBLE.has(signature.code)) return { kind: 'ai' };
  return {
    kind: 'give_up',
    reason: aiAvailable
      ? 'No safe automated repair for this failure.'
      : 'No rule matched and AI diagnosis is not configured.',
  };
}

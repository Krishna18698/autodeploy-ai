import { parseVersion, pickMajor } from './semver.js';

// Deterministic repository analysis. Every conclusion carries the evidence
// that produced it, so the UI can show "why" and nothing here needs an LLM.

export const SUPPORTED_NODE_MAJORS = [18, 20, 22, 24] as const;
export const DEFAULT_NODE_MAJOR = 22;

export type FileTree = {
  /** Repo-relative POSIX paths of every file (directories omitted). */
  files: readonly string[];
  /** File contents, or undefined if missing / too large / binary. */
  read(path: string): string | undefined;
};

export type Evidence = { source: string; detail: string };
export type Inference<T> = { value: T; evidence: Evidence[] };

export type Framework = 'next' | 'vite' | 'astro' | 'cra' | 'static' | 'unknown';
export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun' | 'none';
export type DeployMode = 'static' | 'ssr' | 'unknown';

export type Analysis = {
  rootDir: string;
  framework: Inference<Framework> & { version?: string };
  packageManager: Inference<PackageManager> & { version?: string };
  node: Inference<number> & { range?: string };
  installCommand: Inference<string | null>;
  buildCommand: Inference<string | null>;
  outputDir: Inference<string>;
  mode: Inference<DeployMode>;
  basePath?: string;
  envVars: Inference<string[]>;
  monorepo: boolean;
  supported: boolean;
  unsupportedReason?: string;
  warnings: string[];
};

type PackageJson = {
  name?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
};

const join = (root: string, p: string) =>
  root === '.' || root === '' ? p : `${root.replace(/\/$/, '')}/${p}`;

function readJson<T>(tree: FileTree, path: string): T | undefined {
  const raw = tree.read(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function firstExisting(tree: FileTree, root: string, names: readonly string[]): string | undefined {
  const set = new Set(tree.files);
  return names.map((n) => join(root, n)).find((p) => set.has(p));
}

function depVersion(pkg: PackageJson | undefined, name: string): string | undefined {
  return pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
}

function majorOf(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const v = parseVersion(range.replace(/^[\^~>=<\s]+/, ''));
  return v?.[0];
}

// Minimum Node majors required by framework releases (from their docs).
function frameworkNodeFloor(
  framework: Framework,
  major: number | undefined,
): { range: string; why: string } | undefined {
  if (major === undefined) return undefined;
  if (framework === 'next' && major >= 16)
    return { range: '>=20.9', why: `next@${major} requires Node >=20.9` };
  if (framework === 'next' && major >= 15)
    return { range: '>=18.18', why: `next@${major} requires Node >=18.18` };
  if (framework === 'vite' && major >= 7)
    return { range: '>=20.19', why: `vite@${major} requires Node >=20.19` };
  if (framework === 'vite' && major >= 5)
    return { range: '>=18', why: `vite@${major} requires Node >=18` };
  if (framework === 'astro' && major >= 5)
    return { range: '>=18.17.1', why: `astro@${major} requires Node >=18.17.1` };
  return undefined;
}

const ENV_PATTERNS: Array<{ re: RegExp; framework: Framework }> = [
  { re: /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g, framework: 'vite' },
  { re: /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g, framework: 'next' },
  { re: /import\.meta\.env\.(PUBLIC_[A-Z0-9_]+)/g, framework: 'astro' },
  { re: /process\.env\.(REACT_APP_[A-Z0-9_]+)/g, framework: 'cra' },
];

const SOURCE_FILE = /\.(m?[jt]sx?|vue|svelte|astro)$/;
const MAX_ENV_SCAN_FILES = 400;

export function analyze(tree: FileTree, rootDir = '.'): Analysis {
  const warnings: string[] = [];
  const pkgPath = join(rootDir, 'package.json');
  const pkg = readJson<PackageJson>(tree, pkgPath);
  const fileSet = new Set(tree.files);

  // --- monorepo -----------------------------------------------------------
  const monorepo =
    fileSet.has(join(rootDir, 'pnpm-workspace.yaml')) ||
    pkg?.workspaces !== undefined ||
    fileSet.has(join(rootDir, 'turbo.json')) ||
    fileSet.has(join(rootDir, 'lerna.json'));
  if (monorepo && rootDir === '.') {
    warnings.push(
      'Monorepo detected: set the project root directory to the app you want to deploy.',
    );
  }

  // --- framework ----------------------------------------------------------
  const fwEvidence: Evidence[] = [];
  let framework: Framework = 'unknown';
  let fwVersion: string | undefined;
  const next = depVersion(pkg, 'next');
  const vite = depVersion(pkg, 'vite');
  const astro = depVersion(pkg, 'astro');
  const cra = depVersion(pkg, 'react-scripts');
  if (next) {
    framework = 'next';
    fwVersion = next;
    fwEvidence.push({ source: 'package.json', detail: `next@${next} in dependencies` });
  } else if (astro) {
    framework = 'astro';
    fwVersion = astro;
    fwEvidence.push({ source: 'package.json', detail: `astro@${astro} in dependencies` });
  } else if (vite) {
    framework = 'vite';
    fwVersion = vite;
    fwEvidence.push({ source: 'package.json', detail: `vite@${vite} in dependencies` });
  } else if (cra) {
    framework = 'cra';
    fwVersion = cra;
    fwEvidence.push({ source: 'package.json', detail: `react-scripts@${cra} in dependencies` });
  } else if (!pkg && fileSet.has(join(rootDir, 'index.html'))) {
    framework = 'static';
    fwEvidence.push({ source: 'index.html', detail: 'no package.json; plain static site' });
  } else {
    fwEvidence.push({
      source: pkg ? 'package.json' : 'repository',
      detail: 'no supported framework found',
    });
  }
  const fwMajor = majorOf(fwVersion);

  // --- package manager ----------------------------------------------------
  const pmEvidence: Evidence[] = [];
  let pm: PackageManager = pkg ? 'npm' : 'none';
  let pmVersion: string | undefined;
  const declared = pkg?.packageManager
    ? /^(pnpm|yarn|npm|bun)@([\w.+-]+)/.exec(pkg.packageManager)
    : null;
  const lockfiles: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  const foundLocks = lockfiles.filter(([f]) => fileSet.has(join(rootDir, f)) || fileSet.has(f));
  if (declared?.[1] && declared[2]) {
    pm = declared[1] as PackageManager;
    pmVersion = declared[2];
    pmEvidence.push({ source: 'package.json', detail: `packageManager: "${pkg?.packageManager}"` });
  } else if (foundLocks[0]) {
    pm = foundLocks[0][1];
    pmEvidence.push({ source: foundLocks[0][0], detail: `${foundLocks[0][0]} present` });
  } else if (pkg) {
    pmEvidence.push({ source: 'package.json', detail: 'no lockfile; defaulting to npm' });
    warnings.push('No lockfile found: dependency versions will float between builds.');
  }
  if (foundLocks.length > 1) {
    warnings.push(`Multiple lockfiles (${foundLocks.map(([f]) => f).join(', ')}): using ${pm}.`);
  }

  // --- node version -------------------------------------------------------
  // Policy: .nvmrc / .node-version > engines.node > framework floor > default.
  const nodeEvidence: Evidence[] = [];
  let nodeRange: string | undefined;
  const nvmPath = firstExisting(tree, rootDir, ['.nvmrc', '.node-version']);
  const nvm = nvmPath ? tree.read(nvmPath)?.trim() : undefined;
  if (nvm && /^v?\d/.test(nvm)) {
    nodeRange = nvm.replace(/^v/, '');
    nodeEvidence.push({ source: nvmPath ?? '.nvmrc', detail: `pins ${nvm}` });
  } else if (pkg?.engines?.node) {
    nodeRange = pkg.engines.node;
    nodeEvidence.push({ source: 'package.json', detail: `engines.node "${pkg.engines.node}"` });
  }
  const floor = frameworkNodeFloor(framework, fwMajor);
  let nodeMajor: number = DEFAULT_NODE_MAJOR;
  if (nodeRange) {
    const picked = pickMajor(nodeRange, SUPPORTED_NODE_MAJORS);
    if (picked !== undefined) {
      nodeMajor = picked;
    } else {
      warnings.push(
        `Node range "${nodeRange}" matches no supported version (${SUPPORTED_NODE_MAJORS.join(', ')}); using ${DEFAULT_NODE_MAJOR}.`,
      );
    }
  } else if (floor) {
    nodeMajor = pickMajor(floor.range, SUPPORTED_NODE_MAJORS) ?? DEFAULT_NODE_MAJOR;
    nodeEvidence.push({ source: 'framework', detail: floor.why });
  } else {
    nodeEvidence.push({
      source: 'default',
      detail: `no Node version declared; using ${DEFAULT_NODE_MAJOR}`,
    });
  }
  if (floor && nodeRange) {
    const floorMajor = pickMajor(floor.range, SUPPORTED_NODE_MAJORS);
    if (floorMajor !== undefined && nodeMajor < (majorOf(floor.range) ?? 0)) {
      warnings.push(
        `${floor.why}, but the repo pins Node ${nodeMajor}. The build may fail; recovery can raise it.`,
      );
    }
  }

  // --- commands -----------------------------------------------------------
  const run = (script: string) =>
    pm === 'npm' ? `npm run ${script}` : pm === 'none' ? null : `${pm} run ${script}`;
  const installCommand: Inference<string | null> = (() => {
    switch (pm) {
      case 'pnpm':
        return { value: 'pnpm install --frozen-lockfile', evidence: pmEvidence };
      case 'yarn':
        return { value: 'yarn install --immutable', evidence: pmEvidence };
      case 'bun':
        return { value: 'bun install --frozen-lockfile', evidence: pmEvidence };
      case 'npm':
        return foundLocks.some(([, m]) => m === 'npm')
          ? { value: 'npm ci', evidence: pmEvidence }
          : { value: 'npm install', evidence: pmEvidence };
      default:
        return { value: null, evidence: [{ source: 'repository', detail: 'nothing to install' }] };
    }
  })();

  let buildCommand: Inference<string | null>;
  if (pkg?.scripts?.build) {
    buildCommand = {
      value: run('build'),
      evidence: [{ source: 'package.json', detail: `scripts.build "${pkg.scripts.build}"` }],
    };
  } else if (framework === 'static') {
    buildCommand = {
      value: null,
      evidence: [{ source: 'index.html', detail: 'static site, no build step' }],
    };
  } else {
    buildCommand = {
      value: null,
      evidence: [{ source: 'package.json', detail: 'no build script' }],
    };
    if (pkg) warnings.push('No "build" script in package.json.');
  }

  // --- mode and output ----------------------------------------------------
  let mode: Inference<DeployMode> = { value: 'unknown', evidence: [] };
  let outputDir: Inference<string> = {
    value: 'dist',
    evidence: [{ source: 'default', detail: 'dist/' }],
  };
  let basePath: string | undefined;
  let unsupportedReason: string | undefined;

  if (framework === 'next') {
    const cfgPath = firstExisting(tree, rootDir, [
      'next.config.ts',
      'next.config.mjs',
      'next.config.js',
      'next.config.cjs',
    ]);
    const cfg = cfgPath ? (tree.read(cfgPath) ?? '') : '';
    const isExport = /output\s*:\s*['"`]export['"`]/.test(cfg);
    const distDir = /distDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1];
    basePath = /basePath\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1];
    if (isExport) {
      mode = {
        value: 'static',
        evidence: [{ source: cfgPath ?? 'next.config', detail: "output: 'export'" }],
      };
      outputDir = {
        value: 'out',
        evidence: [{ source: cfgPath ?? 'next.config', detail: 'static export writes to out/' }],
      };
      if (distDir)
        warnings.push(`next.config sets distDir "${distDir}"; the export still lands in out/.`);
    } else {
      mode = {
        value: 'ssr',
        evidence: [
          {
            source: cfgPath ?? 'next.config',
            detail: cfgPath ? "no output: 'export'" : 'no next.config',
          },
        ],
      };
      unsupportedReason =
        "This Next.js app needs a server (no output: 'export'). AutoDeploy V1 serves static sites only.";
    }
  } else if (framework === 'vite') {
    const cfgPath = firstExisting(tree, rootDir, [
      'vite.config.ts',
      'vite.config.mts',
      'vite.config.js',
      'vite.config.mjs',
    ]);
    const cfg = cfgPath ? (tree.read(cfgPath) ?? '') : '';
    const out = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1];
    basePath = /\bbase\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1];
    const ssr = /\bssr\s*:/.test(cfg) && /vite-plugin-ssr|vike|@vitejs\/plugin-ssr/.test(cfg);
    mode = ssr
      ? {
          value: 'ssr',
          evidence: [{ source: cfgPath ?? 'vite.config', detail: 'SSR plugin configured' }],
        }
      : {
          value: 'static',
          evidence: [{ source: cfgPath ?? 'package.json', detail: 'Vite builds a static bundle' }],
        };
    if (out)
      outputDir = {
        value: out.replace(/^\.\//, ''),
        evidence: [{ source: cfgPath ?? 'vite.config', detail: `build.outDir "${out}"` }],
      };
    else
      outputDir = { value: 'dist', evidence: [{ source: 'vite', detail: 'default outDir dist/' }] };
    if (ssr)
      unsupportedReason =
        'This Vite app is configured for server-side rendering. V1 serves static sites only.';
  } else if (framework === 'astro') {
    const cfgPath = firstExisting(tree, rootDir, [
      'astro.config.mjs',
      'astro.config.ts',
      'astro.config.js',
    ]);
    const cfg = cfgPath ? (tree.read(cfgPath) ?? '') : '';
    const server = /output\s*:\s*['"`](server|hybrid)['"`]/.exec(cfg)?.[1];
    basePath = /\bbase\s*:\s*['"`]([^'"`]+)['"`]/.exec(cfg)?.[1];
    mode = server
      ? {
          value: 'ssr',
          evidence: [{ source: cfgPath ?? 'astro.config', detail: `output: '${server}'` }],
        }
      : {
          value: 'static',
          evidence: [{ source: cfgPath ?? 'astro', detail: 'default static output' }],
        };
    outputDir = { value: 'dist', evidence: [{ source: 'astro', detail: 'default outDir dist/' }] };
    if (server)
      unsupportedReason = `This Astro app uses output: '${server}' and needs a server. V1 serves static sites only.`;
  } else if (framework === 'cra') {
    mode = {
      value: 'static',
      evidence: [{ source: 'package.json', detail: 'Create React App builds static files' }],
    };
    outputDir = {
      value: 'build',
      evidence: [{ source: 'react-scripts', detail: 'CRA writes to build/' }],
    };
  } else if (framework === 'static') {
    mode = { value: 'static', evidence: [{ source: 'index.html', detail: 'plain HTML' }] };
    outputDir = {
      value: '.',
      evidence: [{ source: 'index.html', detail: 'served from the repository root' }],
    };
  } else if (pkg?.scripts?.build) {
    mode = {
      value: 'static',
      evidence: [{ source: 'package.json', detail: 'unknown framework; assuming a static build' }],
    };
    warnings.push('Framework not recognised; assuming the build writes static files to dist/.');
  } else {
    unsupportedReason = 'Could not find a supported framework or a build script.';
  }

  if (basePath && basePath !== '/') {
    warnings.push(
      `Configured base path "${basePath}": sites are served from the subdomain root, so assets may 404.`,
    );
  }

  // --- env vars -----------------------------------------------------------
  const envNames = new Set<string>();
  const envEvidence: Evidence[] = [];
  const candidates = tree.files
    .filter(
      (f) =>
        (rootDir === '.' || f.startsWith(`${rootDir}/`)) &&
        SOURCE_FILE.test(f) &&
        !f.includes('node_modules/'),
    )
    .slice(0, MAX_ENV_SCAN_FILES);
  for (const file of candidates) {
    const text = tree.read(file);
    if (!text) continue;
    for (const { re } of ENV_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const name = m[1];
        if (name && !envNames.has(name)) {
          envNames.add(name);
          envEvidence.push({ source: file, detail: `references ${name}` });
        }
      }
    }
  }

  const supported = unsupportedReason === undefined;
  return {
    rootDir,
    framework: {
      value: framework,
      evidence: fwEvidence,
      ...(fwVersion !== undefined && { version: fwVersion }),
    },
    packageManager: {
      value: pm,
      evidence: pmEvidence,
      ...(pmVersion !== undefined && { version: pmVersion }),
    },
    node: {
      value: nodeMajor,
      evidence: nodeEvidence,
      ...(nodeRange !== undefined && { range: nodeRange }),
    },
    installCommand,
    buildCommand,
    outputDir,
    mode,
    ...(basePath !== undefined && { basePath }),
    envVars: { value: [...envNames].sort(), evidence: envEvidence },
    monorepo,
    supported,
    ...(unsupportedReason !== undefined && { unsupportedReason }),
    warnings,
  };
}

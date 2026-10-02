// Guardrails for AI-proposed source patches. The model never gets to decide
// what is safe: every diff is parsed and checked here before it is applied.

export type FileChange = {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  addedLines: string[];
};

export type PolicyViolation = { path?: string; rule: string; detail: string };

export type PolicyResult = {
  allowed: boolean;
  needsApproval: boolean;
  files: FileChange[];
  violations: PolicyViolation[];
  approvalReasons: string[];
};

export const LIMITS = { maxFiles: 5, maxChangedLines: 80 } as const;

const DENY: Array<[RegExp, string]> = [
  [/^\.github\//, 'CI workflows are off-limits'],
  [/(^|\/)\.env(\.|$)/, 'environment files are off-limits'],
  [/\.(pem|key|p12|crt)$/, 'key material is off-limits'],
  [/(^|\/)\.npmrc$|(^|\/)\.yarnrc/, 'registry configuration is off-limits'],
  [/(^|\/)Dockerfile$/, 'container definitions are off-limits'],
  [/^\.\.?\/|\/\.\.\//, 'path traversal'],
];

const NEEDS_APPROVAL: Array<[RegExp, string]> = [
  [/(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/, 'changes a lockfile'],
  [/(^|\/)package\.json$/, 'changes package.json'],
  [/\.config\.(m?[jt]s|cjs)$/, 'changes build configuration'],
];

const ALLOWED_PREFIX = /^(src|app|pages|components|lib|utils|hooks|styles|public|content)\//;
const ALLOWED_ROOT = /^[^/]+\.(config\.(m?[jt]s|cjs)|json|html)$/;

const SUSPICIOUS_ADDED: Array<[RegExp, string]> = [
  [/\b(child_process|execSync|spawnSync)\b/, 'introduces process execution'],
  [/\beval\s*\(|new Function\s*\(/, 'introduces dynamic code evaluation'],
  [/https?:\/\/(?!localhost)[^\s'"]+\.(sh|exe|bin)\b/, 'references a remote executable'],
  [
    /process\.env\.(?!NODE_ENV|VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_)[A-Z_]+/,
    'reads a non-public environment variable',
  ],
];

/** Minimal unified-diff parser: enough to count and inspect changes per file. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: m?.[2] ?? '',
        added: 0,
        removed: 0,
        isNew: false,
        isDeleted: false,
        binary: false,
        addedLines: [],
      };
      files.push(current);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (!current) {
        current = {
          path: p,
          added: 0,
          removed: 0,
          isNew: false,
          isDeleted: false,
          binary: false,
          addedLines: [],
        };
        files.push(current);
      } else if (p !== '/dev/null') {
        current.path = p;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.isNew = true;
    else if (line.startsWith('deleted file mode')) current.isDeleted = true;
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch'))
      current.binary = true;
    else if (line.startsWith('--- ')) continue;
    else if (line.startsWith('+')) {
      current.added++;
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) current.removed++;
  }
  return files.filter((f) => f.path !== '');
}

export function checkPatch(diff: string): PolicyResult {
  const files = parseUnifiedDiff(diff);
  const violations: PolicyViolation[] = [];
  const approvalReasons: string[] = [];

  if (files.length === 0) violations.push({ rule: 'empty', detail: 'the patch changes no files' });
  if (files.length > LIMITS.maxFiles) {
    violations.push({
      rule: 'max-files',
      detail: `${files.length} files changed (limit ${LIMITS.maxFiles})`,
    });
  }
  const changed = files.reduce((n, f) => n + f.added + f.removed, 0);
  if (changed > LIMITS.maxChangedLines) {
    violations.push({
      rule: 'max-lines',
      detail: `${changed} lines changed (limit ${LIMITS.maxChangedLines})`,
    });
  }

  for (const f of files) {
    if (f.binary)
      violations.push({ path: f.path, rule: 'binary', detail: 'binary changes are not allowed' });
    if (f.isDeleted)
      violations.push({ path: f.path, rule: 'delete', detail: 'deleting files is not allowed' });
    const denied = DENY.find(([re]) => re.test(f.path));
    if (denied) {
      violations.push({ path: f.path, rule: 'denied-path', detail: denied[1] });
      continue;
    }
    if (!ALLOWED_PREFIX.test(f.path) && !ALLOWED_ROOT.test(f.path)) {
      violations.push({
        path: f.path,
        rule: 'outside-scope',
        detail: 'outside the directories repairs may touch',
      });
      continue;
    }
    const approval = NEEDS_APPROVAL.find(([re]) => re.test(f.path));
    if (approval) approvalReasons.push(`${f.path} ${approval[1]}`);
    if (
      /(^|\/)package\.json$/.test(f.path) &&
      f.addedLines.some((l) => /"(pre|post)?(install|prepare|build)"\s*:/.test(l))
    ) {
      violations.push({
        path: f.path,
        rule: 'lifecycle-script',
        detail: 'patches may not add or change install/build scripts',
      });
    }
    for (const line of f.addedLines) {
      const bad = SUSPICIOUS_ADDED.find(([re]) => re.test(line));
      if (bad) violations.push({ path: f.path, rule: 'suspicious-code', detail: bad[1] });
    }
  }

  return {
    allowed: violations.length === 0,
    // Source patches from a model always need a human; this only records why.
    needsApproval: true,
    files,
    violations,
    approvalReasons: approvalReasons.length ? approvalReasons : ['AI-generated source change'],
  };
}

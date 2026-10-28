import type { Edit } from './edits.js';
import type { ErrorSignature } from './signatures.js';

// Deterministic fixes to a repository's files, for failures whose cause can be
// read off the files themselves, tried before any AI. Unlike rules (build
// settings only), these change the user's code, so they go the way of an AI
// patch: shown as a diff, checked by patch policy, built and validated, and
// published only once someone approves.

export type SourceFix = {
  ruleId: string;
  title: string;
  explanation: string;
  edits: Edit[];
};

export type RepoFiles = {
  files: readonly string[];
  read(path: string): string | undefined;
};

// JSON with comments and trailing commas allowed (read by tools that accept
// them): never "fixed" as strict JSON.
const JSONC =
  /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.eslintrc\.json|devcontainer\.json)$|(^|\/)\.(vscode|devcontainer)\//i;

/**
 * Drops each comma that only a closing } or ] follows (outside strings),
 * keeping everything else byte for byte.
 */
export function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

const parses = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * R-009: the build failed parsing JSON, and exactly one JSON file in the
 * repository is invalid only because of trailing commas. (AI kept failing
 * here: the text around a trailing comma repeats, so its edits couldn't say
 * which comma.)
 */
function trailingCommas(signature: ErrorSignature, repo: RepoFiles): SourceFix | undefined {
  const log = [signature.keyLine, ...signature.excerpt].join('\n');
  if (!/JSON|EJSONPARSE/.test(log)) return undefined;
  const fixable: { path: string; before: string; after: string }[] = [];
  for (const path of repo.files) {
    if (!path.endsWith('.json') || JSONC.test(path)) continue;
    const before = repo.read(path);
    if (before === undefined || parses(before)) continue;
    const after = removeTrailingCommas(before);
    // Broken for another reason too: not this fix's to guess at.
    if (!parses(after)) return undefined;
    fixable.push({ path, before, after });
  }
  const [only] = fixable;
  if (!only || fixable.length > 1) return undefined;
  return {
    ruleId: 'R-009',
    title: `Remove trailing commas from ${only.path}`,
    explanation: `${only.path} has a comma before a closing bracket, which JSON doesn't allow, so the build couldn't read it. Removing it changes nothing else in the file.`,
    edits: [{ path: only.path, find: only.before, replace: only.after }],
  };
}

const SOURCE_FIXES = [trailingCommas];

/** The first deterministic fix for this failure, if any. */
export function findSourceFix(signature: ErrorSignature, repo: RepoFiles): SourceFix | undefined {
  for (const fix of SOURCE_FIXES) {
    const found = fix(signature, repo);
    if (found) return found;
  }
  return undefined;
}

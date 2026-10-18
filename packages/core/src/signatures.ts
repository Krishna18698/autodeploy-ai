import { createHash } from 'node:crypto';

// Turns a failed build log into a stable error signature. Two failures with
// the same signature are "the same problem", which is how recovery knows a
// fix didn't work and stops instead of looping.

export type ErrorCode =
  | 'NODE_ENGINE'
  | 'LOCKFILE_MISMATCH'
  | 'PEER_DEPS'
  | 'MODULE_NOT_FOUND'
  | 'TS_COMPILE'
  | 'SYNTAX_ERROR'
  | 'OUTPUT_DIR_MISSING'
  | 'SCRIPT_MISSING'
  | 'NETWORK_TRANSIENT'
  | 'OUT_OF_MEMORY'
  | 'MISSING_ENV'
  | 'SSR_REQUIRED'
  | 'TIMEOUT'
  | 'PLATFORM'
  | 'UNKNOWN';

export type ErrorSignature = {
  code: ErrorCode;
  /** Stable hash of code + normalized key line. */
  signature: string;
  /** The normalized line that decided the classification. */
  keyLine: string;
  /** A few raw lines around the key line, for humans and the AI context. */
  excerpt: string[];
  /** Values pulled out of the log that rules can use (e.g. a required node range). */
  captures: Record<string, string>;
};

type Matcher = {
  code: ErrorCode;
  re: RegExp;
  /** Named captures to keep. */
  keep?: string[];
};

// Order matters: the first matching line wins, and more specific patterns
// come before generic ones.
const MATCHERS: Matcher[] = [
  { code: 'PLATFORM', re: /^autodeploy: no build image for Node/ },
  { code: 'TIMEOUT', re: /^autodeploy: build exceeded (?<limit>\d+)s/ },
  {
    code: 'OUTPUT_DIR_MISSING',
    re: /^autodeploy: output directory "(?<dir>[^"]+)" (?:was not produced|has no index\.html)/,
    keep: ['dir'],
  },
  {
    code: 'NODE_ENGINE',
    re: /(?:engine "node" is incompatible with this module\. Expected version "(?<range>[^"]+)"|Unsupported engine.*?required: \{?\s*node:\s*'(?<range2>[^']+)'|requires Node\.?js (?:version )?(?<range3>[>=^~]*\s*\d[\d.x]*\+?)|You are using Node\.js \S+\. (?:Vite|Next\.js|Astro) requires Node\.js version (?<range4>[^.]+?\d[\d.]*)\b|ERR_PNPM_UNSUPPORTED_ENGINE)/i,
    keep: ['range', 'range2', 'range3', 'range4'],
  },
  {
    code: 'LOCKFILE_MISMATCH',
    re: /(ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|`npm ci` can only install packages when your package\.json and package-lock\.json|The lockfile would have been modified by this install, which is explicitly forbidden|YN0028)/,
  },
  {
    code: 'PEER_DEPS',
    re: /(ERESOLVE (?:unable to resolve dependency tree|could not resolve)|ERR_PNPM_PEER_DEP_ISSUES)/,
  },
  {
    code: 'SCRIPT_MISSING',
    re: /(Missing script: "?build"?|ERR_PNPM_NO_SCRIPT|Couldn't find a script named "build")/,
  },
  {
    code: 'OUT_OF_MEMORY',
    re: /(JavaScript heap out of memory|FATAL ERROR: Reached heap limit|exit code 137|Killed\s*$)/,
  },
  {
    code: 'NETWORK_TRANSIENT',
    re: /(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND registry|socket hang up|ERR_SOCKET_TIMEOUT|503 Service Unavailable|network timeout at)/,
  },
  {
    code: 'SSR_REQUIRED',
    re: /(Page ".*" is missing "generateStaticParams\(\)" so it cannot be used with "output: export"|cannot be used with "output: export"|API Routes cannot be used with "output: export")/,
  },
  {
    code: 'MISSING_ENV',
    re: /\b(?<name>(?:VITE|NEXT_PUBLIC|PUBLIC|REACT_APP)_[A-Z0-9_]+)\b.*\b(is not defined|is undefined|is missing|must be set|required)/,
    keep: ['name'],
  },
  // Server-side variables have no telltale prefix, so match how apps say it,
  // never a bare "X is not defined" (that is a ReferenceError in the code).
  {
    code: 'MISSING_ENV',
    re: /(?:\bprocess\.env\.(?<name2>[A-Z][A-Z0-9_]*) is (?:undefined|not set|missing)|\b[Mm]issing (?:required )?env(?:ironment)?(?: var(?:iable)?s?)?:? ['"`]?(?<name3>[A-Z][A-Z0-9_]*)|\benv(?:ironment)? var(?:iable)? ['"`]?(?<name4>[A-Z][A-Z0-9_]*)['"`]? (?:is )?(?:missing|not set|required|undefined)|Invalid environment variables:?.*?\b(?<name5>[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b|\b(?<name6>[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])\b['"`]? (?:is missing|must be set|is not set|is required|was not set|was not provided))/,
    keep: ['name'],
  },
  {
    code: 'MODULE_NOT_FOUND',
    re: /(?:Cannot find module '(?<mod>[^']+)'|Module not found: (?:Error: )?Can't resolve '(?<mod2>[^']+)'|Failed to resolve import "(?<mod3>[^"]+)"|Could not resolve "(?<mod4>[^"]+)")/,
    keep: ['mod', 'mod2', 'mod3', 'mod4'],
  },
  { code: 'TS_COMPILE', re: /(error TS\d+:|Type error: )/ },
  { code: 'SYNTAX_ERROR', re: /(SyntaxError:|Unexpected token|Transform failed with \d+ error)/ },
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip everything that changes between runs but not between causes. */
export function normalizeLine(line: string): string {
  return line
    .replace(ANSI, '')
    .replace(/^\s*\d{4}-\d\d-\d\dT[\d:.]+Z?\s*/, '') // ISO timestamps
    .replace(/\b\d{1,2}:\d\d:\d\d(?:\.\d+)?(?:\s?(?:AM|PM)\b)?/g, '<time>')
    .replace(/(?:\/[\w.@+-]+)+\/(?=[\w.@+-]+)/g, '') // absolute dirs (keep basename)
    .replace(/\(\d+,\d+\)|:\d+:\d+\b/g, ':<pos>')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|kB|KB|MB|GB|B)\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classify(logLines: readonly string[], exitCode?: number): ErrorSignature {
  const clean = logLines.map((l) => l.replace(ANSI, ''));
  for (const m of MATCHERS) {
    for (let i = 0; i < clean.length; i++) {
      const raw = clean[i] ?? '';
      const match = m.re.exec(raw);
      if (!match) continue;
      const captures: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.groups ?? {})) {
        if (v !== undefined) captures[k.replace(/\d+$/, '')] = v.trim();
      }
      const keyLine = normalizeLine(raw);
      return {
        code: m.code,
        signature: hashSignature(m.code, keyLine),
        keyLine,
        // Node prints the failing file four lines above a SyntaxError
        // (path, code, caret, blank), so look a little further back.
        excerpt: clean.slice(Math.max(0, i - 5), i + 4),
        captures,
      };
    }
  }
  const tail = clean.filter((l) => l.trim() !== '').slice(-8);
  const keyLine = normalizeLine(tail.at(-1) ?? `exit ${exitCode ?? '?'}`);
  const code: ErrorCode = exitCode === 137 ? 'OUT_OF_MEMORY' : 'UNKNOWN';
  return { code, signature: hashSignature(code, keyLine), keyLine, excerpt: tail, captures: {} };
}

function hashSignature(code: ErrorCode, keyLine: string): string {
  return `${code}:${createHash('sha256').update(`${code}\n${keyLine}`).digest('hex').slice(0, 12)}`;
}

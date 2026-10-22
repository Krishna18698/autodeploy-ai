// AI patches arrive as edits ("in this file, replace this exact text with
// that"), not as hand-written unified diffs: models reliably copy text, but
// often drop a diff's line breaks or miscount its hunk headers. The diff that
// patch policy checks, `git apply` applies and the dashboard shows is computed
// here from the files' real contents.

export type Edit = { path: string; find: string; replace: string };

export type EditResult =
  | { ok: true; files: { path: string; before: string | null; after: string }[] }
  | { ok: false; error: string };

/**
 * Applies edits in order. `find` must occur exactly once in the file as it
 * stands (after earlier edits), so a vague or invented edit is refused rather
 * than guessed at. An empty `find` on a missing file creates it.
 */
export function applyEdits(
  read: (path: string) => string | undefined,
  edits: readonly Edit[],
): EditResult {
  const now = new Map<string, string | null>();
  const before = new Map<string, string | null>();
  for (const e of edits) {
    const path = e.path.replace(/^(\.\/|\/)+/, '');
    if (!path) return { ok: false, error: 'an edit has no file path' };
    if (!now.has(path)) {
      const content = read(path) ?? null;
      now.set(path, content);
      before.set(path, content);
    }
    const text = now.get(path) ?? null;
    if (text === null) {
      if (e.find !== '') return { ok: false, error: `${path} does not exist` };
      now.set(path, e.replace);
      continue;
    }
    if (e.find === '') return { ok: false, error: `the edit to ${path} has nothing to replace` };
    const found = occurrences(text, e.find);
    if (found.length === 0)
      return { ok: false, error: `the text to replace was not found in ${path}` };
    // The retry is told where each copy is, so it can quote enough to pick one.
    if (found.length > 1)
      return {
        ok: false,
        error: `the text to replace appears more than once in ${path} (starting on lines ${found.map((f) => f.line).join(', ')})`,
      };
    const at = found[0]?.at as number;
    now.set(path, text.slice(0, at) + e.replace + text.slice(at + e.find.length));
  }
  const files = [...now]
    .filter(([p, after]) => after !== null && after !== before.get(p))
    .map(([path, after]) => ({ path, before: before.get(path) ?? null, after: after ?? '' }));
  return { ok: true, files };
}

/** Where `find` occurs in `text`: offset and 1-based starting line. */
function occurrences(text: string, find: string) {
  const out: { at: number; line: number }[] = [];
  let line = 1;
  let counted = 0;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) {
    for (; counted < at; counted++) if (text.charCodeAt(counted) === 10) line++;
    out.push({ at, line });
  }
  return out;
}

const CONTEXT = 3;
type Op = { kind: ' ' | '-' | '+'; text: string; oldNo: number; newNo: number };

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  const lines = (finalNewline ? text.slice(0, -1) : text).split('\n');
  return { lines, finalNewline };
}

/** Line diff (longest common subsequence); files here are a few hundred lines at most. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string, oldNo: ++i, newNo: ++j });
    } else if (
      j < m &&
      (i >= n || ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    ) {
      ops.push({ kind: '+', text: b[j] as string, oldNo: i, newNo: ++j });
    } else {
      ops.push({ kind: '-', text: a[i] as string, oldNo: ++i, newNo: j });
    }
  }
  return ops;
}

/** A git-style unified diff of one file (`before` null = a new file). */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = splitLines(before ?? '');
  const b = splitLines(after);
  // A last line without a newline differs from the same text with one.
  const NOEOL = '\u0000';
  const keyed = (s: { lines: string[]; finalNewline: boolean }) =>
    s.lines.map((l, i) => (i === s.lines.length - 1 && !s.finalNewline ? l + NOEOL : l));
  const ops = diffLines(keyed(a), keyed(b)).map((o) => ({ ...o, text: o.text.replace(NOEOL, '') }));
  const changed = ops.flatMap((o, k) => (o.kind === ' ' ? [] : [k]));
  if (changed.length === 0) return '';

  // Group changes into hunks, merging those whose context would touch.
  const ranges: [number, number][] = [];
  for (const k of changed) {
    const last = ranges.at(-1);
    if (last && k - last[1] <= 2 * CONTEXT + 1) last[1] = k;
    else ranges.push([k, k]);
  }
  const out = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
    `+++ b/${path}`,
  ];
  for (const [first, last] of ranges) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    const hunk = ops.slice(from, to + 1);
    const oldCount = hunk.filter((o) => o.kind !== '+').length;
    const newCount = hunk.filter((o) => o.kind !== '-').length;
    // Start lines are 1-based; an empty side points at the line before it.
    const firstOld = hunk.find((o) => o.kind !== '+');
    const firstNew = hunk.find((o) => o.kind !== '-');
    const oldStart = oldCount ? (firstOld?.oldNo ?? 0) : (hunk[0]?.oldNo ?? 0);
    const newStart = newCount ? (firstNew?.newNo ?? 0) : (hunk[0]?.newNo ?? 0);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) {
      out.push(`${o.kind}${o.text}`);
      const lastOld = o.kind !== '+' && o.oldNo === a.lines.length && !a.finalNewline;
      const lastNew = o.kind !== '-' && o.newNo === b.lines.length && !b.finalNewline;
      if (
        (o.kind === '-' && lastOld) ||
        (o.kind === '+' && lastNew) ||
        (o.kind === ' ' && (lastOld || lastNew))
      )
        out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}

/** Edits → one multi-file unified diff, or why the edits could not be applied. */
export function editsToDiff(
  read: (path: string) => string | undefined,
  edits: readonly Edit[],
): { ok: true; diff: string } | { ok: false; error: string } {
  const r = applyEdits(read, edits);
  if (!r.ok) return r;
  const diff = r.files.map((f) => unifiedDiff(f.path, f.before, f.after)).join('');
  return diff ? { ok: true, diff } : { ok: false, error: 'the edits change nothing' };
}

/** The reverse, for fixtures written as diffs: each hunk becomes one edit. */
export function diffToEdits(diff: string): Edit[] {
  const edits: Edit[] = [];
  let path = '';
  let find: string[] | null = null;
  let replace: string[] = [];
  const flush = () => {
    if (find && path) edits.push({ path, find: find.join('\n'), replace: replace.join('\n') });
    find = null;
    replace = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      path = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      flush();
      find = [];
    } else if (find && !line.startsWith('\\')) {
      if (line.startsWith('-')) find.push(line.slice(1));
      else if (line.startsWith('+')) replace.push(line.slice(1));
      else if (line.startsWith(' ')) {
        find.push(line.slice(1));
        replace.push(line.slice(1));
      }
    }
  }
  flush();
  return edits;
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { filesMentioned } from '@autodeploy/ai';
import { applyEdits, checkPatch, diffToEdits, editsToDiff, unifiedDiff } from '@autodeploy/core';
import { describe, expect, it } from 'vitest';

/** Writes `before`, applies `diff` with real git, returns the file afterwards. */
function gitApply(path: string, before: string | null, diff: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'edits-'));
  try {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    if (before !== null) writeFileSync(join(dir, path), before);
    const r = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dir, input: diff });
    if (r.status !== 0) throw new Error(`git apply: ${r.stderr}`);
    return readFileSync(join(dir, path), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');

describe('AI edits become real diffs', () => {
  it.each([
    ['one changed line', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['first and last lines', 'a\nb\nc\nd\n', 'A\nb\nc\nD\n'],
    [
      'changes far apart (two hunks)',
      `${long}\n`,
      `${long.replace('line 2\n', 'two\n').replace('line 38', 'thirty-eight')}\n`,
    ],
    [
      'changes close together (one hunk)',
      `${long}\n`,
      `${long.replace('line 10\n', 'ten\n').replace('line 14', 'fourteen')}\n`,
    ],
    ['inserted lines', 'a\nb\n', 'a\nnew 1\nnew 2\nb\n'],
    ['deleted lines', 'a\nb\nc\nd\n', 'a\nd\n'],
    ['no newline at end, before and after', 'a\nb', 'a\nc'],
    ['adds the final newline', 'a\nb', 'a\nb\n'],
    ['removes the final newline', 'a\nb\n', 'a\nb'],
  ])('%s', (_label, before, after) => {
    const diff = unifiedDiff('src/f.ts', before, after);
    expect(gitApply('src/f.ts', before, diff)).toBe(after);
  });

  it('creates a new file', () => {
    const diff = unifiedDiff('src/new.ts', null, 'export const x = 1;\n');
    expect(diff).toContain('new file mode');
    expect(gitApply('src/new.ts', null, diff)).toBe('export const x = 1;\n');
  });

  it('turns edits into a diff that passes policy and applies', () => {
    const files: Record<string, string> = { 'src/cfg.ts': 'export const port: string = 3000;\n' };
    const r = editsToDiff(
      (p) => files[p],
      [{ path: 'src/cfg.ts', find: 'string = 3000', replace: "string = '3000'" }],
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.diff).toContain("+export const port: string = '3000';");
    expect(checkPatch(r.diff).allowed).toBe(true);
    expect(gitApply('src/cfg.ts', files['src/cfg.ts'] ?? '', r.diff)).toBe(
      "export const port: string = '3000';\n",
    );
  });

  it('refuses edits it cannot place exactly', () => {
    const read = (p: string) => (p === 'a.ts' ? 'x = 1;\nx = 1;\n' : undefined);
    expect(applyEdits(read, [{ path: 'a.ts', find: 'y', replace: 'z' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    });
    expect(applyEdits(read, [{ path: 'a.ts', find: 'x = 1;', replace: 'z' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('more than once'),
    });
    expect(applyEdits(read, [{ path: 'gone.ts', find: 'x', replace: 'y' }])).toMatchObject({
      ok: false,
    });
    expect(
      editsToDiff(read, [{ path: 'a.ts', find: 'x = 1;\nx', replace: 'x = 1;\nx' }]),
    ).toMatchObject({
      ok: false,
      error: 'the edits change nothing',
    });
  });

  it('reads fixture diffs back as edits', () => {
    const diff = unifiedDiff('src/cfg.ts', 'a\nport = 3000;\nb\n', "a\nport = '3000';\nb\n");
    const edits = diffToEdits(diff);
    const r = editsToDiff(() => 'a\nport = 3000;\nb\n', edits);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.diff).toBe(diff);
  });
});

describe('finding the files an error points at', () => {
  it.each([
    ["src/main.ts(4,26): error TS2339: Property 'user' does not exist", ['src/main.ts']],
    ['file:///workspace/src/util.mjs:1', ['src/util.mjs']],
    ['    at /tmp/ai-eval-x/src/index.mjs:2:9', ['src/index.mjs']],
    ['./src/a.tsx:3:1 Unexpected token', ['src/a.tsx']],
    // The tree is rooted at the project's root directory (here apps/web).
    ['/workspace/apps/web/src/b.ts:1:1', ['src/b.ts']],
    ['npm error code ELIFECYCLE', []],
  ])('%s', (line, expected) => {
    expect(filesMentioned([line])).toEqual(expected);
  });
});

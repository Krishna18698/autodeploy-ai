import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyEdits,
  checkPatch,
  classify,
  decideRecovery,
  editsToDiff,
  findSourceFix,
  removeTrailingCommas,
} from '@autodeploy/core';
import { afterAll, describe, expect, it } from 'vitest';
import { EXTRA_AI_CASES } from '../ai-eval/cases';

// Audit #21: the AI kept failing on a trailing comma in a JSON file (the text
// around a trailing comma repeats, so its edits couldn't say which comma).
// R-009 fixes it without AI, and still waits for approval like any code change.

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'source-fix-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}
const tree = (files: Record<string, string>) => ({
  files: Object.keys(files).sort(),
  read: (p: string) => files[p],
});
/** Runs the build the way the sandbox does, and returns its log and exit code. */
function build(dir: string, cmd: string[]) {
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? 1, log: `${r.stdout}${r.stderr}`.split('\n') };
}
const jsonFailure = classify([
  'SyntaxError: Unexpected token \']\', ..."about",\n  ]\n}" is not valid JSON',
]);

describe('R-009: trailing commas in a JSON file', () => {
  it('removes only commas before a closing bracket, never inside strings', () => {
    const text = '{\n  "a": [1, 2,],\n  "s": "x,]",\n  "e": "q\\",}",\n  "o": {"k": 1 ,  }\n}\n';
    expect(removeTrailingCommas(text)).toBe(
      '{\n  "a": [1, 2],\n  "s": "x,]",\n  "e": "q\\",}",\n  "o": {"k": 1   }\n}\n',
    );
    expect(JSON.parse(removeTrailingCommas(text))).toEqual({
      a: [1, 2],
      s: 'x,]',
      e: 'q",}',
      o: { k: 1 },
    });
  });

  it("fixes the AI evaluation's case from its real build log, and the build then passes", async () => {
    const c = EXTRA_AI_CASES.find((x) => x.name === 'ai-json-trailing-comma');
    if (!c) throw new Error('case missing');
    const dir = await repo(c.files);
    const failed = build(dir, ['node', 'build.mjs']);
    expect(failed.code).not.toBe(0);
    const signature = classify(failed.log, failed.code);
    // Routed to a code fix even with no AI at all.
    const decision = decideRecovery(
      { signature, config: {} as never, framework: 'node', packageManager: 'npm', indexDirs: [] },
      { signatures: [signature.signature], appliedRules: [], repairsMade: 0 },
      false,
    );
    expect(decision).toEqual({ kind: 'source', ai: false });

    const fix = findSourceFix(signature, tree(c.files));
    expect(fix?.ruleId).toBe('R-009');
    expect(fix?.title).toBe('Remove trailing commas from src/nav.json');
    const diff = editsToDiff((p) => c.files[p], fix?.edits ?? []);
    if (!diff.ok) throw new Error(diff.error);
    // One line changed, and the patch policy lets it through.
    expect(diff.diff).toContain('\n-    "about",\n');
    expect(diff.diff).toContain('\n+    "about"\n');
    expect(diff.diff.match(/^[-+] /gm)).toHaveLength(2);
    expect(checkPatch(diff.diff).allowed).toBe(true);

    const applied = applyEdits((p) => c.files[p], fix?.edits ?? []);
    if (!applied.ok) throw new Error(applied.error);
    for (const f of applied.files) await writeFile(join(dir, f.path), f.after);
    expect(build(dir, ['node', 'build.mjs']).code).toBe(0);
    expect(await readFile(join(dir, 'dist/index.html'), 'utf8')).toContain('ok');
  });

  it("fixes a package.json npm can't read", async () => {
    const pkg =
      '{\n  "name": "site",\n  "private": true,\n  "scripts": {\n    "build": "node build.mjs"\n  },\n}\n';
    const files = { 'package.json': pkg, 'build.mjs': "console.log('built');\n" };
    const dir = await repo(files);
    const failed = build(dir, ['npm', 'run', 'build']);
    expect(failed.code).not.toBe(0);
    const fix = findSourceFix(classify(failed.log, failed.code), tree(files));
    expect(fix?.title).toBe('Remove trailing commas from package.json');
    const applied = applyEdits((p) => files[p as keyof typeof files], fix?.edits ?? []);
    if (!applied.ok) throw new Error(applied.error);
    await writeFile(join(dir, 'package.json'), applied.files[0]?.after ?? '');
    expect(build(dir, ['npm', 'run', 'build']).code).toBe(0);
  });

  it.each([
    [
      'a JSON-with-comments file (tsconfig allows trailing commas)',
      { 'tsconfig.json': '{ "compilerOptions": { "strict": true, }, }' },
    ],
    [
      'two broken files (which one did the build read?)',
      { 'a.json': '[1,]', 'b.json': '{"x": 1,}' },
    ],
    ['a file broken in another way too', { 'data.json': '{ "x": 1, "y": unquoted, }' }],
  ])('leaves alone %s', (_why, files) => {
    expect(findSourceFix(jsonFailure, tree(files))).toBeUndefined();
  });

  it('only when the build failed reading JSON', () => {
    const other = classify(['SyntaxError: Unexpected token )']);
    expect(findSourceFix(other, tree({ 'data.json': '[1,]' }))).toBeUndefined();
    expect(findSourceFix(jsonFailure, tree({ 'data.json': '[1,]' }))?.ruleId).toBe('R-009');
  });
});

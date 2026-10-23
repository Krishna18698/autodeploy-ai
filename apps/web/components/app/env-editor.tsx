'use client';

import { parseDotenv } from '@autodeploy/core/dotenv';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

// Environment variables set while importing, before the first build: the
// names the analysis found in the code are listed to fill in, more can be
// added by hand or from a .env file. Empty ones are left out.

export type EnvRow = { id: string; key: string; value: string; detected?: boolean };

const NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
let nextId = 0;
const newRow = (key = '', value = '', detected = false): EnvRow => ({
  id: `env-${++nextId}`,
  key,
  value,
  detected,
});

/** The detected names as rows, keeping anything already typed for them. */
export function rowsFor(detected: string[], current: EnvRow[]): EnvRow[] {
  const kept = current.filter((r) => r.value !== '' || !r.detected);
  const have = new Set(kept.map((r) => r.key));
  return [...detected.filter((k) => !have.has(k)).map((k) => newRow(k, '', true)), ...kept];
}

/** What to send: named, filled-in rows (the last one wins for a repeated name). */
export function envToSend(rows: EnvRow[]): { key: string; value: string }[] {
  const out = new Map<string, string>();
  for (const r of rows) if (r.key && r.value !== '') out.set(r.key, r.value);
  return [...out].map(([key, value]) => ({ key, value }));
}

/** Rows that would be refused: a filled-in value under a name that isn't valid. */
export const badRows = (rows: EnvRow[]) =>
  rows.filter((r) => r.value !== '' && !NAME.test(r.key)).length;

export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseDotenv(text), [text]);
  const set = (id: string, patch: Partial<EnvRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
    e.target.value = '';
  };
  // From a .env: fill the rows that have the name, add the rest.
  const addFromFile = () => {
    const next = [...rows];
    for (const v of parsed.vars) {
      const at = next.findIndex((r) => r.key === v.key);
      const existing = next[at];
      if (existing) next[at] = { ...existing, value: v.value };
      else next.push(newRow(v.key, v.value));
    }
    onChange(next);
    setText('');
    setImporting(false);
  };

  return (
    <section
      aria-labelledby="env-title"
      className="flex flex-col gap-3 rounded-[8px] border border-line bg-panel p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="env-title" className="text-[14px] font-medium">
            Environment variables
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Saved encrypted and used from the first build. Leave one empty if the site doesn’t need
            it.
          </p>
        </div>
        <Button size="sm" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>
          {importing ? 'Close import' : 'Import .env'}
        </Button>
      </div>

      {importing && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-bg/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-muted">Paste a .env file, or choose one.</p>
            <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-[12px] hover:bg-raised/60">
              Choose file
              <input
                type="file"
                accept=".env,.txt,text/plain"
                onChange={pick}
                className="sr-only"
              />
            </label>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'DATABASE_URL=postgres://…\nVITE_API_URL=https://…'}
            aria-label=".env contents"
            spellCheck={false}
            rows={5}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-run/60 [-webkit-text-security:disc]"
          />
          {parsed.skipped.map((s) => (
            <p key={s.line} className="font-mono text-[12px] text-fail">
              line {s.line} skipped: {s.reason}
            </p>
          ))}
          <div>
            <Button
              size="sm"
              variant="primary"
              disabled={parsed.vars.length === 0}
              onClick={addFromFile}
            >
              Add {parsed.vars.length} variable{parsed.vars.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const bad = r.key !== '' && !NAME.test(r.key);
            return (
              <li key={r.id} className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <input
                    value={r.key}
                    onChange={(e) => set(r.id, { key: e.target.value.toUpperCase() })}
                    placeholder="NAME"
                    aria-label="Variable name"
                    aria-invalid={bad || undefined}
                    spellCheck={false}
                    className={`h-9 w-[42%] min-w-0 rounded-md border bg-bg px-2.5 font-mono text-[16px] outline-none focus:border-run/60 sm:text-[13px] ${bad ? 'border-fail/60' : 'border-line'}`}
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    value={r.value}
                    onChange={(e) => set(r.id, { value: e.target.value })}
                    placeholder={r.detected ? 'found in your code' : 'value'}
                    aria-label={`Value for ${r.key || 'this variable'}`}
                    className="h-9 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 font-mono text-[16px] outline-none focus:border-run/60 sm:text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                    aria-label={`Remove ${r.key || 'this variable'}`}
                    className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"
                  >
                    <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
                      <path
                        d="M5 5l10 10M15 5L5 15"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
                {bad && (
                  <p className="text-[12px] text-fail">
                    Use capital letters, digits and _, like VITE_API_URL.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={() => onChange([...rows, newRow()])}>
          + Add variable
        </Button>
      </div>
    </section>
  );
}

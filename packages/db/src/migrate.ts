import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transitionPairs } from '@autodeploy/core';
import type { Sql } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 727_001; // arbitrary, constant: one migrator at a time

export type MigrationResult = { applied: string[]; skipped: number };

export async function migrate(
  sql: Sql,
  dir = MIGRATIONS_DIR,
  log: (m: string) => void = () => {},
): Promise<MigrationResult> {
  await sql`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now()
  )`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  let skipped = 0;

  await sql.begin(async (tx) => {
    // Serialise concurrent deploys running migrations at the same time.
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    const done = new Map(
      (
        await tx<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`
      ).map((r) => [r.name, r.checksum]),
    );
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`migration ${file} was edited after being applied`);
        skipped++;
        continue;
      }
      log(`applying ${file}`);
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name, checksum) values (${file}, ${checksum})`;
      applied.push(file);
    }
    await syncTransitionRules(tx as unknown as Sql);
  });
  return { applied, skipped };
}

/** The DB trigger enforces exactly the state machine defined in packages/core. */
export async function syncTransitionRules(sql: Sql): Promise<void> {
  const pairs = transitionPairs();
  await sql`delete from deployment_transition_rules`;
  await sql`insert into deployment_transition_rules ${sql(pairs.map(([from_status, to_status]) => ({ from_status, to_status })))}`;
}

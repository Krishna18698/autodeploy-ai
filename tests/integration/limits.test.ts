import { createSql, type Sql } from '@autodeploy/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aiBudgetLeft } from '../../apps/worker/src/ai-budget';
import { makeOrg } from './helpers';

let sql: Sql;
beforeAll(() => {
  sql = createSql(inject('databaseUrl'));
});
afterAll(() => sql.end());

const calls = (org: string, n: number, when = 'now()') =>
  sql.unsafe(
    `insert into ai_usage (org_id, provider, model, purpose, outcome, created_at)
     select $1, 'nvidia', 'm', 'diagnose', 'ok', ${when} from generate_series(1, $2)`,
    [org, n],
  );

describe('AI repair calls a day', () => {
  it("cap each account at its share, and everyone at the platform's", async () => {
    const [a, b, c] = [await makeOrg(sql), await makeOrg(sql), await makeOrg(sql)];
    // Other tests may have used some of today's platform budget already.
    const [{ n: before } = { n: 0 }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_usage where created_at >= date_trunc('day', now())`;
    const env = { AI_CALLS_PER_ORG_PER_DAY: 60, AI_DAILY_CALL_BUDGET: before + 70 };

    await calls(c, 100, "now() - interval '1 day'");
    expect(await aiBudgetLeft(sql, env, c)).toBe(true); // yesterday's don't count

    await calls(a, 59);
    expect(await aiBudgetLeft(sql, env, a)).toBe(true);
    await calls(a, 1);
    expect(await aiBudgetLeft(sql, env, a)).toBe(false); // a's 60 used
    expect(await aiBudgetLeft(sql, env, b)).toBe(true); // b unaffected

    await calls(b, 10); // the platform's 70 for today now used, b's own 10 not
    expect(await aiBudgetLeft(sql, env, b)).toBe(false);
    expect(await aiBudgetLeft(sql, env, c)).toBe(false);
    expect(await aiBudgetLeft(sql, env, null)).toBe(false);
  });
});

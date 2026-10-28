import { createSql, type Sql } from '@autodeploy/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SiteCookieMemory } from '../../apps/worker/src/gateway/cookies';
import { makeOrg, makeProject } from './helpers';

// The gateway's memory of each project's cookie names outlives the gateway
// (a restart or redeploy must not open the gap for first-time visitors).

let sql: Sql;
const log = { warn() {} };
beforeAll(() => {
  sql = createSql(inject('databaseUrl'), { max: 3 });
});
afterAll(() => sql.end());

describe('remembered cookie names', () => {
  it('survive a restart, follow what the app last said, and go with the project', async () => {
    const orgId = await makeOrg(sql);
    const { id } = await makeProject(sql, orgId);
    const first = new SiteCookieMemory(sql, log);
    await first.get(id);
    await first.learn(
      id,
      orgId,
      new Map([
        ['sid', { protect: true, sameSite: 'lax' as const }],
        ['theme', { protect: false, sameSite: null }],
      ]),
    );
    await first.learn(
      id,
      orgId,
      new Map([['sid', { protect: true, sameSite: 'strict' as const }]]),
    );

    const restarted = new SiteCookieMemory(sql, log);
    expect(Object.fromEntries(await restarted.get(id))).toEqual({
      sid: { protect: true, sameSite: 'strict' },
      theme: { protect: false, sameSite: null },
    });

    await sql`delete from projects where id = ${id}`;
    expect(await sql`select 1 from site_cookies where project_id = ${id}`).toHaveLength(0);
  });
});

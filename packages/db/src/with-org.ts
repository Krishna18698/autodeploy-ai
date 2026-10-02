import type { Sql, Tx } from './client.js';

/**
 * Runs `fn` in a transaction scoped to one tenant: sets app.org_id and drops
 * to the app_user role, so row-level security filters every query even if
 * the code forgets an org condition.
 */
export async function withOrg<T>(sql: Sql, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    await tx`set local role app_user`;
    return fn(tx);
  });
  return result as T;
}

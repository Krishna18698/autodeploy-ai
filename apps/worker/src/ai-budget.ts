import type { Sql } from '@autodeploy/db';
import type { Env } from './env.js';

/**
 * Two AI budgets a day: the platform's (free provider tiers) and each org's
 * share of it, so one account can't spend everyone's AI repairs. With no org
 * (work outside any account) only the platform's applies.
 */
export async function aiBudgetLeft(
  sql: Sql,
  env: Pick<Env, 'AI_DAILY_CALL_BUDGET' | 'AI_CALLS_PER_ORG_PER_DAY'>,
  orgId: string | null,
): Promise<boolean> {
  const [r] = await sql<{ total: number; mine: number }[]>`
    select count(*)::int as total, count(*) filter (where org_id = ${orgId})::int as mine
    from ai_usage where created_at >= date_trunc('day', now())`;
  return (
    (r?.total ?? 0) < env.AI_DAILY_CALL_BUDGET &&
    (orgId === null || (r?.mine ?? 0) < env.AI_CALLS_PER_ORG_PER_DAY)
  );
}

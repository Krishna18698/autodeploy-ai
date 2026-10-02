import type { Sql } from '@autodeploy/db';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    auditTarget?: { type: string; id: string; metadata?: Record<string, unknown> };
  }
}

/** Records every successful mutation that declares `config.audit`. */
export const auditPlugin = fp(async (app: FastifyInstance, o: { sql: Sql }) => {
  app.addHook('onResponse', async (req, reply) => {
    const action = req.routeOptions.config.audit;
    if (!action || !req.auth || reply.statusCode >= 400) return;
    const t = req.auditTarget;
    await o.sql`
      insert into audit_events (org_id, actor_user_id, actor_token_id, action, target_type, target_id, ip, metadata)
      values (${req.auth.orgId}, ${req.auth.userId}, ${req.auth.tokenId ?? null}, ${action},
              ${t?.type ?? null}, ${t?.id ?? null}, ${req.ip}, ${o.sql.json((t?.metadata ?? {}) as never)})`.catch(
      (err) => req.log.error({ err, action }, 'failed to write audit event'),
    );
  });
});

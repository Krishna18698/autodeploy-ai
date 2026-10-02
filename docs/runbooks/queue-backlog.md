# Runbook: queue backlog / stuck deployments

Symptoms: `QueueBacklog` alert, deployments sitting in QUEUED.

1. Is the worker up? `docker compose ps worker`, `curl worker:9464/healthz`.
2. What is queued? `select type, status, count(*), min(run_at) from jobs group by 1,2;`
3. Per-org cap: one org can hold `PER_ORG_BUILD_LIMIT` builds; others still run.
4. Leases: `select id, locked_by, lease_until from jobs where status='running';`
   Expired leases are requeued every 15 s by the leader's reaper; a job that
   exhausts its attempts goes `dead` and its deployment is marked FAILED.
5. Dead jobs: inspect `last_error`; requeue deliberately with
   `update jobs set status='queued', attempts=0, run_at=now() where id=…;`

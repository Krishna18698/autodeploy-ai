# Runbook: deploy

1. CI → "ci" workflow → *Run workflow* (builds arm64 images tagged with the commit SHA).
2. On the VM: `cd infra/deploy && IMAGE_TAG=<sha> ./deploy.sh`.
   - api-1 restarts first and applies migrations under an advisory lock.
   - Caddy health-checks `/readyz`, so traffic only reaches ready replicas.
   - The worker drains: no new claims, 20 s for in-flight builds, then leases
     are released so the next worker picks the jobs up immediately.
3. Verify: `curl https://api.<domain>/readyz`, the Grafana ops dashboard, and
   one deploy through the dashboard.

Rollback of the platform itself: rerun `deploy.sh` with the previous SHA.
Migrations are additive; never edit an applied migration (the migrator
refuses a changed checksum).

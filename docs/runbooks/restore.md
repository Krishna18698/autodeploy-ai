# Runbook: restore from backup

Drill monthly; record the time in docs/measurements.md.

1. Download the newest object from `s3://<bucket>/backups/daily/`.
2. `AGE_IDENTITY=~/.config/age/backup.key infra/backup/restore-drill.sh <file>`
   — restores into a throwaway Postgres and prints row counts and duration.
3. Real restore: stop api/worker, restore into the production volume the same
   way, start api (migrations are idempotent), then worker.
4. Re-mirror routes: the leader's `route-reconcile` task pushes every active
   route to KV within 10 minutes (or restart the worker to run it now).

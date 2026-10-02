# 3. Content-addressed artifacts and pointer-flip activation

Status: accepted · 2026-09

## Decision
Build output is hashed into a manifest; the artifact id is the hash. Files
are uploaded once under `sites/<sha>/`. A site is "live" because a route
(`route:<slug>` in Workers KV, mirrored from Postgres) points at that sha.
Activation and rollback change only that pointer, under a per-project
advisory lock, with an optimistic version check on the project row.

## Consequences
- Rollback measured at 11.7 ms; nothing rebuilt or re-uploaded.
- Identical builds deduplicate (5 deployments, 4 artifacts in the demo data).
- The edge never needs the origin: KV + object storage serve every request.
- The KV write happens before commit; if commit fails the route is put back,
  and a reconcile task re-mirrors Postgres → KV every 10 minutes.

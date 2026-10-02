# Measurements

Numbers quoted on the landing page and in the case study. Each has a source
you can rerun. Phase 12 tests replace the "local run" figures with test
reports.

| Question | Answer | Source |
|---|---|---|
| Rollback time | 11.7 ms pointer flip, no rebuild | `POST /projects/:id/rollback` response (local run) |
| Duplicate side effects after redelivery | 0 (11 events republished, 11 processed per group) | outbox relay crash/redelivery, local run |
| Failure fixtures recovered | 3/3 (R-004, R-005, AI + approval) | `tests/fixtures/*`, local run |
| Analytics rebuilt from Kafka | 72 events → 5 rows in 550 ms | `pnpm replay:analytics` |
| One trace across services | API → prepare → build → recover → build → activate, 9 spans | Jaeger, local run |
| First vite build in sandbox | 9.2 s (install through egress proxy + build) | attempt duration, local run |

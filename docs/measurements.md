# Measurements

Every number on the landing page and in the case study, with the command
that produces it. Run against the local stack (`pnpm infra:up`,
`./scripts/dev.sh start`) on an Apple-silicon laptop with 2 build slots.

| Question | Answer | Command |
|---|---|---|
| Duplicate job claims under contention | **0** (500 jobs, 8 concurrent workers, 122 ms) | `pnpm test:integration` (queue) |
| Webhook redelivery | **100 concurrent redeliveries → 1 deployment** | `pnpm test:integration` (api) |
| Cross-tenant access | **0 leaks** across a role × endpoint matrix; foreign ids → 404 | `pnpm test:integration` (api) |
| Rollback | **3.7 ms** pointer flip (11.7 ms through the API) | `pnpm test:integration` (db) |
| Failure corpus, rules only | **38/38 as labelled · 64% of failures recovered (14/22)** | `AI_PROVIDERS= ./scripts/dev.sh restart worker && pnpm corpus --mode rules` |
| Failure corpus, rules + AI | **38/38 · 82% recovered (18/22) · 0 false fixes** | `AI_PROVIDERS=mock … && pnpm corpus --mode ai` |
| Sandbox escape attempts | **5/5 contained** (egress, read-only root, docker socket, fork bomb, secret echo) | corpus `sec-*` |
| Worker SIGKILL mid-build | rebuild started **36 s** later, deployment went live | `pnpm chaos` |
| Kafka down mid-deploy | deploy still live; **11** outbox events drained **6.5 s** after recovery | `pnpm chaos` |
| All worker DB connections killed | transparent reconnect, deploy live | `pnpm chaos` |
| Object storage down at upload | recovered **22 s** after it returned | `pnpm chaos` |
| Kafka replay | **50 events → projection in 225 ms**; 72 events/550 ms on the dev data | `pnpm test:integration` (events), `pnpm replay:analytics` |
| One trace across services | API → prepare → build → recover → build → activate, 9 spans | Jaeger, `OTEL_EXPORTER_OTLP_ENDPOINT` set |
| Load: deploy writes | p95 **276 ms** across 50 projects; **762 ms** for 50 to one project (numbering serialises) | `pnpm load` |
| Load: reads | p95 **18 ms** at ~3.1k req/s | `pnpm load` |
| Load: correctness | **100/100** built, 0 multi-attempt builds, 0 duplicate jobs | `pnpm load` |
| Landing (Lighthouse, mobile) | performance **89–90**, accessibility **100**, best practices **100**, CLS **0**, TBT ≤100 ms | `npx lighthouse … --skip-audits=bf-cache` |
| Edge storage reads | **30 site requests → 2 storage reads** (was 85): manifest-checked misses, immutable edge cache. Fits B2's free 2,500 reads/day | old vs new Worker behind a counting proxy |
| Landing in production (Vercel, Lighthouse mobile) | performance **96** (2 of 3 runs; the first, cold run scored 58 with a 1.8 s blocking spike), accessibility/best practices/SEO **100**, CLS **0**, LCP 2.7 s | `npx lighthouse https://autodeploy-zeta.vercel.app --skip-audits=bf-cache` ×3 |
| Dashboard accessibility | **0** serious/critical axe violations on 7 pages | `pnpm test:e2e` |

## Bugs the tests found (and fixed)

| Found by | Bug |
|---|---|
| unit | Redactor echoed the whole line around `[redacted]` for token patterns (secret leak) |
| unit | Log normalizer merged words after timestamps; exact `.nvmrc` pins ignored |
| integration | A consumer stalled forever publishing to a missing DLQ topic |
| integration | Jobs scheduled with the app clock were delayed by host clock skew |
| corpus | Repairs endpoint returned 500 when a rule added an env var |
| corpus | Node's fetch bypassed the sandbox proxy; missing images blamed on users |
| chaos | Live logs blocked builds when Kafka was down |
| chaos | Kafka consumers never reconnected after a broker outage |
| chaos | Worker refused to start without Kafka |
| chaos | Deployments interrupted mid-publish stayed VALIDATING forever |
| e2e | Roll back button vanished after a new deploy (stale state) |
| e2e / Lighthouse | Nested-interactive chart, landing overflow on phones, 2.6 s main-thread block at load, ARIA/contrast issues |
| review | Edge re-read `index.html` from storage on every request and probed 3 paths per SPA route (85 reads for 30 requests, now 2) |

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
| OWASP ZAP | API: **118 pass / 0 warn / 0 fail**; landing: **0 fail**, warnings 8 → 4 after adding CSP + Permissions-Policy | `tests/security/README.md` |
| AI classifier (Workers AI, Qwen3-30B) | **18/18 valid answers** (was **0/18**: the model spent its 300-token budget thinking), 0 fixable failures wrongly stopped, gate 15/18, p50 **1.0 s** | `pnpm tsx tests/ai-eval/classifier.ts` |
| Production edge path (Cloudflare → Worker → KV → B2) | **6/6 checks**: live 2.4 s after the KV write, SPA fallback, immutable assets, 404s, security headers; warm requests **27–29 ms**; cleaned up | `pnpm tsx tests/smoke/edge.ts` |
| SSR runtime (the owner's real portfolio, Next.js 16) | built + validated in **36 s**; cold start **2.7 s** (first: fetch + unpack bundle), **0.94 s** after idle (bundle cached), warm **14–22 ms**; stopped after 2 min idle (test setting), woken by the next request; POST API routes and per-request rendering verified | local stack, `ok-next-ssr` corpus case |
| SSR egress (SSRF guard) | public hosts allowed; metadata, private, loopback and `localhost` all **refused and logged** | `tests/unit/ssr.test.ts`, proxy in public mode |
| Dashboard accessibility | **0** serious/critical axe violations on 7 pages | `pnpm test:e2e` |
| Production smoke (real user flows on the live stack) | **12/12** on 2026-10-08: static site, pinned pnpm, server-rendered app (POST, egress, metadata refused), env var → Deploy again, clicked navigation at 977/390 px, delete → site off the edge in ~30 s; everything created was deleted | `E2E_BASE_URL=https://app.autodeploy.dpdns.org pnpm test:smoke` |
| SSR runtime on the production VM (gVisor, arm64) | build + validation passed; cold start **4.0 s**; outbound HTTPS allowed, metadata refused; **63 MB** of its 256 MB limit | VM three-stage check (build → validator → runtime) |
| Real-AI repair (NVIDIA nemotron-3-super, corpus replay) | **12/12** fixable cases fixed (3 runs × 4), **6/6** unfixable ones escalated, **0** false fixes, mean AI call **4.0 s**; judged by the real TypeScript compiler, and a "fix" that adds a file counts as false. Before this round's fixes the same path fixed **0%** | `pnpm tsx tests/ai-eval/repair.ts` → `tests/ai-eval/repair-report.md` |
| Push to deploy in production | a real repository's pushes deployed on their own (3 of 3) | GitHub App webhook → production |
| Landing after the header and phone wipe changes | performance **89** (2 warm runs; a cold first run scored 59, as before), accessibility **100**, CLS **0** | `npx lighthouse http://127.0.0.1:3100/ --skip-audits=bf-cache` |

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
| AI eval | Workers AI classifier never answered: Qwen3 reasons before replying and used all 300 tokens; every call failed and the breaker opened, silently skipping the cheap gate |
| SSR bring-up | Analysis cache keys weren't versioned: an old "unsupported" verdict would have been served for 7 days (now `ANALYSIS_VERSION`) |
| SSR bring-up | `next/font/google` downloads fonts during `next build`; the build egress allowlist blocked Google Fonts, failing most Next.js apps |
| SSR bring-up | Sites using Vercel Analytics/Speed Insights failed validation on `/_vercel/*` 404s (platform-only paths, now skipped) |
| owner's screenshot | Dashboard pages stayed invisible after a click: the page transition's exit could stall at opacity 0 (now a CSS fade; the smoke suite clicks through every page) |
| production smoke | An npm app in a pnpm monorepo was installed with pnpm (the repository root's lockfile won) |
| production smoke | A pinned pnpm/yarn version crashed the build: corepack wrote into the read-only image (`EROFS`) |
| production smoke | A repository the GitHub App can't see returned a bare 500 instead of "give the App access" |
| review | Deleting a project left its sites served from the edge (KV routes were never removed) |
| production check | Server-rendered sites turned into 404s up to 10 minutes after going live: the KV re-sync dropped the route's mode (now one route builder and an integration test) |
| production check | A mistyped site address hung and showed Cloudflare's 522 instead of a 404 |
| production smoke | A missing server-side env var (no `VITE_`-style prefix) ended as FAILED instead of "needs input" |
| production smoke + AI eval | AI repair fixed nothing with real models: diffs written by the model lost their line breaks (now edits; AutoDeploy computes the diff), NVIDIA's json_object mode invented field names (now json_schema), absolute paths in logs hid the broken file from the model, the excerpt cut off Node's SyntaxError file line, and a renamed module's new name was never shown |
| review | The worker's metrics never reached Grafana: they were only exposed for scraping, and nothing scrapes in production (now also pushed over OTLP) |
| key check | The configured NVIDIA model never answered on the free endpoint (no reply in 150 s); `pnpm keys:check` now proves every key before shipping |
| production smoke | AI fixes for a project in a subdirectory never applied (patches are relative to the root directory, but were applied at the repository root; opening the fix as a PR had the same problem) |
| review | A root or output directory such as `../..`, an absolute path or a symlink could reach outside the checkout: host files into a published artifact or an AI prompt. Now refused by the API schema and again, after resolving symlinks, wherever a host path is built |

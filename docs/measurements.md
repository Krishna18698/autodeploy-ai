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
| Sandbox escape attempts | **5/5 contained** locally (egress, read-only root, docker socket, fork bomb, secret echo); **production, 2026-10-22: 10/10 contained** (internet, cloud metadata, API, Postgres, Valkey, gateway, host SSH, writes outside the build folder, host files, secret redacted) | corpus `sec-*`; smoke `hostile-build` |
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
| OWASP ZAP | API: **118 pass / 0 warn / 0 fail**; landing: **0 fail**, warnings 8 → 4 after adding CSP + Permissions-Policy. Production re-scan 2026-10-22 (passive): **0 high, 0 fail**; nothing new to fix | `tests/security/README.md` |
| AI classifier (Workers AI, Qwen3-30B) | **18/18 valid answers** (was **0/18**: the model spent its 300-token budget thinking), 0 fixable failures wrongly stopped, gate 15/18, p50 **1.0 s** | `pnpm tsx tests/ai-eval/classifier.ts` |
| Production edge path (Cloudflare → Worker → KV → B2) | **6/6 checks**: live 2.4 s after the KV write, SPA fallback, immutable assets, 404s, security headers; warm requests **27–29 ms**; cleaned up | `pnpm tsx tests/smoke/edge.ts` |
| SSR runtime (the owner's real portfolio, Next.js 16) | built + validated in **36 s**; cold start **2.7 s** (first: fetch + unpack bundle), **0.94 s** after idle (bundle cached), warm **14–22 ms**; stopped after 2 min idle (test setting), woken by the next request; POST API routes and per-request rendering verified | local stack, `ok-next-ssr` corpus case |
| SSR egress (SSRF guard) | public hosts allowed; metadata, private, loopback and `localhost` all **refused and logged** | `tests/unit/ssr.test.ts`, proxy in public mode |
| Dashboard accessibility | **0** serious/critical axe violations on 7 pages | `pnpm test:e2e` |
| Production smoke with real AI (2026-10-19) | **16/16** in 6.0 min: everything below plus a real type error repaired by the AI (NVIDIA), approved in the dashboard and live; a missing env var ends as NEEDS_INPUT and is fixed by importing a .env; crash reports; notification email; every live site matches its pinned address | `E2E_BASE_URL=https://app.autodeploy.dpdns.org E2E_AI=1 pnpm test:smoke` |
| Production smoke (real user flows on the live stack) | **12/12** on 2026-10-08: static site, pinned pnpm, server-rendered app (POST, egress, metadata refused), env var → Deploy again, clicked navigation at 977/390 px, delete → site off the edge in ~30 s; everything created was deleted | `E2E_BASE_URL=https://app.autodeploy.dpdns.org pnpm test:smoke` |
| SSR runtime on the production VM (gVisor, arm64) | build + validation passed; cold start **4.0 s**; outbound HTTPS allowed, metadata refused; **63 MB** of its 256 MB limit | VM three-stage check (build → validator → runtime) |
| Real-AI repair (NVIDIA nemotron-3-ultra, corpus replay, 2026-10-21) | **12/12** fixable cases fixed (3 runs × 4), **6/6** unfixable ones escalated, **0** false fixes, mean AI call **3.4 s**; OpenRouter (same model) 3/4, 2/2, 0. nemotron-3-super, measured 12/12 before, was withdrawn from NVIDIA's free endpoint that day; DeepSeek V4.1 Flash and GLM-5.3 timed out there, Kimi K2.6 errored ([report](../tests/ai-eval/repair-report.md)) |
| Real-AI repair, widened (11 cases, 2026-10-22) | Five realistic cases added (missing export, typo'd variable, JSON trailing comma, await outside async, upstream API down). NVIDIA Nemotron 3 Ultra **7/8** fixed, **3/3** escalated, **0** false fixes; Cloudflare GPT-OSS 120B (new third provider) **7/8**, **3/3**, **0** — before the context and prompt fixes it made 1 false fix (hid the API outage with try/catch) and missed the JSON file entirely ([report](../tests/ai-eval/repair-report.md)) |
| Push to deploy in production | a real repository's pushes deployed on their own (3 of 3) | GitHub App webhook → production |
| Real-AI repair, 2026-10-24 (11 cases, 3 runs) | NVIDIA **21/24** fixed (88%), **9/9** escalated, **0** false fixes, mean AI call **5.7 s**; Cloudflare Workers AI **7/8**, **3/3**, **0**, 5.4 s. Every miss was the trailing comma in JSON (the text around it repeats, so the edit couldn't say which comma): since 2026-10-28 rule R-009 fixes it with no AI call ([report](../tests/ai-eval/repair-report.md)) | `pnpm tsx tests/ai-eval/repair.ts` |
| Capacity of the production VM (2026-10-24) | **20** real server-rendered sites awake (10 Next.js, 10 Node): **~1.1 GiB** in all (~57 MiB each), free memory never below 7.4 GiB; **~15,000 requests, every one 200**; throughput levels off at **~150–160 pages/s** with CPU the limit; median response **78 → 247 ms** from 5 to 20 busy sites; idle awake sites cost ~0 CPU; a 21st wake put the longest-idle site to sleep, and it woke again on its next visit | sites woken in steps of 5 through their public addresses, each step loaded |
| A build while every site is busy (CPU split, 2026-10-24) | **227 s**, against 71 s alone and **676 s** before the split; the build got 0.44 CPU and the sites 0.91 (the slices' 50:100 weights); the API stayed fast (median **52 ms**, p95 **190 ms**, 0 failures) | two sites saturating the sites slice, load sent straight to the gateway ([ADR 0008](adr/0008-ssr-runtime.md)) |
| SSR wake on the production VM (2026-10-24, after the bundle is left unpacked by the build) | Next.js **1.7–2.8 s** at the gateway (**4.4–7.8 s** that morning); a plain Node server **~0.5 s** (~1.4 s before) | the gateway's per-wake timing log |
| The owner's portfolio deployed in production (Next.js 16, server-rendered, 2026-10-29) | build **106 s**, validation in Chromium **26 s**, live **1.6 s** after that: **133 s** from build start to live, with the log streaming throughout | `node tools/screenshots/capture.mjs --deploy` (records the status changes) |
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
| production load test | A load test used up Workers KV's free 100,000 reads for the day, and every site answered 500. The edge now keeps each address's route for 30 s and asks the origin when KV fails |
| capacity test | "20 awake sites" at full limits needed ~15.5 GB of a 12 GB VM (sites now wake only with 4 GB free); a build took 676 s with sites busy (227 s with the CPU split); unpacked server bundles were never deleted (67 of them, 2.5 GB) |
| AI eval | The AI could never fix a trailing comma in JSON: the text around it repeats, so its edit couldn't say which comma (now rule R-009, no AI) |
| production smoke | A busy Backblaze was retried 10 times at the edge (up to ~50 s), leaving visitors on a hung page; now 2 retries within 10 s |
| review | Sites on the shared domain could set, clear or flood each other's cookies ([ADR 0011](adr/0011-cookies-on-the-shared-sites-domain.md)) |
| production incident | A site's server killed for going over its memory answered 502 for ~10 minutes, until a redeploy; the gateway now notices a dead server and starts it again on the next visit |
| Backblaze outage | During Backblaze's US-East incident, storage reads from the VM hung with no time limit; now 10 s to connect and 20 s of silence, then a retry |
| screenshot harness | The deployment page stayed on "Ready" after the deploy went live, and the log panel flashed empty as it did |

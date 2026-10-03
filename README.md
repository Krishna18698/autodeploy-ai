# AutoDeploy

**Deploys that fix themselves.** Connect a repository; AutoDeploy works out
how to build it, builds it in a sandbox, repairs the failures it understands,
validates the result in a real browser, and serves it from the edge — showing
every decision it made along the way.

A portfolio project focused on backend reliability: job orchestration,
failure recovery, multi-tenant security and observability, on a ₹0 budget.

```
GitHub ─webhook─▶ API (Fastify, 2×) ─tx─▶ Postgres ── jobs (SKIP LOCKED, leases)
                     │  RLS · idempotency · rate limits     │      outbox ─▶ Kafka ─┬─ realtime  → SSE
                     ▼                                       ▼                      ├─ notifier  → webhooks · email
                 Dashboard (Next.js)                   Worker ──▶ gVisor sandbox     └─ analytics → projection (replayable)
                                                          │  rules → AI gateway → approval
                                                          ▼
                                    Backblaze B2 (content-addressed) ◀── Edge Worker (*.domain, KV routes)
```

## What it does

- **Analyzes** a repo deterministically (framework, package manager, Node
  version, build command, output dir, SSR vs static, env vars) and shows the
  evidence for every inference.
- **Builds** each attempt in a fresh gVisor container: read-only root, dropped
  capabilities, cgroup limits, no network except an allowlisting proxy to the
  package registries.
- **Recovers**: error signatures → deterministic, configuration-only rules
  (Node version, output dir, lockfile, heap) → AI diagnosis and a minimal patch
  that is policy-checked, rebuilt, validated, and **approved by a human**.
  Validated rule fixes become project settings.
- **Validates** in headless Chromium with no network, and keeps a screenshot.
- **Ships** content-addressed artifacts; going live or rolling back moves one
  pointer (measured 11.7 ms).
- **Streams** build logs and status over SSE (resumable), via Kafka.

## Backend concepts, and where they live

| Concept | Where |
|---|---|
| Job queue: SKIP LOCKED, per-org fairness, leases + heartbeats, reaper, backoff with jitter, dead-letter, cancellation | `packages/queue` |
| State machine enforced in code **and** by a DB trigger | `packages/core/src/state-machine.ts`, `packages/db/migrations` |
| Transactional outbox → Kafka; idempotent consumers; DLQ; replay | `packages/db/src/outbox.ts`, `packages/events`, `apps/worker/src/consumers` |
| Multi-tenancy: roles, scoped API tokens, Postgres RLS | `apps/api/src/plugins/auth.ts`, `packages/db/src/with-org.ts` |
| Idempotency keys, sliding-window rate limits (Lua), CSRF, audit log | `apps/api/src/plugins` |
| Webhooks in (HMAC, delivery dedupe) and out (signed, retried, SSRF-guarded) | `apps/api/src/routes/github-webhooks.ts`, `apps/worker/src/jobs/integrations.ts` |
| Envelope encryption with key rotation | `packages/crypto` |
| Circuit breakers, retries, timeouts, bulkheads | `packages/resilience`, `packages/ai` |
| OpenTelemetry traces across API → queue → worker; Prometheus metrics | `packages/telemetry`, `apps/worker/src/metrics.ts` |
| Leader-elected maintenance (advisory lock) | `apps/worker/src/cron.ts` |
| Zero-downtime deploys, encrypted backups, restore drill, IaC | `infra/` |

Decisions and trade-offs are in [`docs/adr`](docs/adr); numbers in
[`docs/measurements.md`](docs/measurements.md).

## Run it locally

Requirements: Node 24, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env            # then fill ENCRYPTION_KEYS and INTERNAL_TOKEN (commands inside)
pnpm infra:up                   # Postgres, Valkey, Kafka, S3 (SeaweedFS), egress proxy
NODE_MAJORS="20 22 24" pnpm --filter @autodeploy/worker sandbox:images
./scripts/dev.sh start          # api :4000 · worker :9464 · web :3000 · edge :8787
```

Open http://localhost:3000, use **Developer sign-in**, and import a public
GitHub repo — or a fixture: `file:///…/tests/fixtures/ts-error` with
`AI_PROVIDERS=mock` shows the whole AI-repair path without any API keys.
API docs: http://localhost:4000/docs.

## Tests

```bash
pnpm test               # 63 unit tests (pure domain code)
pnpm test:integration   # 24 tests on real Postgres / Valkey / Kafka (Testcontainers)
pnpm test:e2e           # 8 Playwright tests against the running stack
pnpm corpus --mode ai   # 38 labelled repos deployed for real (also --mode rules)
pnpm chaos              # kill the worker, Kafka, DB connections, storage mid-deploy
pnpm load               # k6: 100 concurrent deploys + polling dashboards
```

Results and the bugs they caught: [`docs/measurements.md`](docs/measurements.md).

## Repository

```
apps/      api · worker · web (landing + dashboard) · edge (Cloudflare Worker) · cli
packages/  core (pure domain) · contracts · db · queue · events · ai · github · storage · crypto · resilience · telemetry
infra/     compose (local) · deploy (prod) · sandbox · terraform · backup · observability
docs/      adr · runbooks · measurements
tests/     fixtures (failure corpus)
```

## Status

Built and verified locally end to end. Production accounts (Oracle Cloud,
Cloudflare, Backblaze, Vercel, GitHub App, AI providers) are not connected
yet; see `infra/deploy/.env.prod.example` and `docs/runbooks/deploy.md`.

# Issues to fix

Small things noticed while using the product; newest last.

- [x] **Colour wipe looks empty on phones.** Fixed 2026-10-18: a band with the wordmark on phones. Between the story and the numbers
  the landing page shows a full-screen cyan panel with the logo (the transition
  from the Relay reference). It works as a quick sweep on desktop, but on a
  phone it reads as a large empty block. Proposed: a thin band with the logo on
  small screens, full sweep on desktop. (`apps/web/components/landing/sections/Wipe.tsx`)
- [x] **Import env keys from a .env file**, or add them by hand. Done 2026-10-18: Environment → Import .env (paste or choose a file; keys previewed, bad lines reported, saved in one transaction).

## Before public

Everything to settle before AutoDeploy is opened beyond the owner (as of 2026-10-19).

**Decisions**
- [ ] **Per-org caps.** Today static projects are unlimited per org; add a project cap
  (e.g. 10), a storage cap and a monthly build-minutes budget so one org can't
  fill B2 or hold the single build slot. (Already capped: 50 deploys/day, 3
  server-rendered projects, 1 build at a time, 300 AI calls/day.)
- [ ] **Automatic deploys of AutoDeploy itself on push** (GitHub Actions: lint and
  tests, then ship, edge and dashboard), or keep a manual yes per deploy. Needs
  three deploy credentials stored as GitHub secrets; the VM keeps its own `.env.prod`.
- [x] **Permanent domain:** autodeploy.fyi (Cloudflare Registrar, bought 2026-10-21). autodeploy.dpdns.org redirects to it; drop it from `legacy_domains` once nothing links there (its free registration lapses June 2027). The eu.org application is no longer needed.
- [ ] **Renew autodeploy.fyi** each October (auto-renew on in Cloudflare).
- [ ] **Who can sign in:** invite-only (one allowlisted GitHub account). Decide the
  sign-up policy and abuse controls before opening it.
- [ ] **"₹0" wording** in the hero badge ("₹0 to run") and the How it works section:
  keep or remove.

**Features**
- [ ] **Server-rendered apps beyond Next.js:** Nuxt, SvelteKit (adapter-node), Astro
  server mode, Remix/React Router, SolidStart and plain Node servers (Express,
  Fastify, Hono) with a start command. In progress.
- [ ] **Email to other people:** Resend refuses free domains, so mail goes from
  onboarding@resend.dev and only reaches the Resend account's owner. Sending to
  other users needs a domain of our own verified in Resend
  (`scripts/resend-domain.ts` and the Terraform records are ready for it).

**Setup to finish**
- [ ] Set the notification email (Settings → Notifications) and confirm a failure
  email arrives.
- [ ] Grafana: service-account token, then install `infra/observability`
  dashboard and alerts and confirm the worker's metrics arrive.
- [ ] UptimeRobot monitors on `api…/healthz` and `app…/login`.
- [ ] Confirm a real error shows up in Sentry (only the key-check test event so far).
- [ ] The API docs description update goes out with the next server deploy.

**Evidence**
- [ ] OpenRouter's two escalation cases weren't measured (free-tier rate limit):
  re-run `pnpm tsx tests/ai-eval/repair.ts --nvidia-runs 0`.
- [ ] Widen the AI evaluation beyond the corpus's 6 AI cases with realistic failures.
- [ ] Renew the `e2e-smoke` API token before 2027-01-06.

## Sign-in hardening (later)

- [ ] **Match GitHub App installations by account id, not login.** Access to an installation is granted when its account name equals the AutoDeploy user's login; a stale login (the owner renamed on GitHub and someone else took the name) could match the wrong account until its owner signs in again. Email accounts can't collide (their logins contain `_`).
- [ ] **Per-account sign-in throttling.** Password sign-in is limited per IP (10/min) and costs ~50 ms of scrypt per try; add a per-address failure counter to slow down guessing spread across many IPs.
- [ ] **Google sign-in** (needs a Google OAuth client from the owner).

